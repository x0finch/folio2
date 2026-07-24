import { env } from "cloudflare:workers";
import { TOP_TOKENS_LIMIT, type TokenInfo } from "@folio/tokens";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { tokenLogoUrl } from "../logo";
import { oracle } from "./internal/oracle";
import { requireAuth } from "./internal/require-auth";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 搜索结果短 TTL 边缘缓存(Workers Cache;搜索是公共数据、非用户私有 → 可跨用户共享)。CGK /search 慢且限流
// → 免重复词反复回源。key 用规范化 query 合成 GET 请求。dev(Miniflare)Cache 可能不持久 → 靠客户端
// debounce/最小长度兜。缓存读写失败一律不阻断,退化为直接回源。
const SEARCH_CACHE_TTL_S = 300;
const SEARCH_CACHE_NAME = "folio-token-search";

async function cachedSearch(q: string): Promise<TokenInfo[]> {
  const key = new Request(`https://folio.internal/token-search?q=${encodeURIComponent(q)}`);
  try {
    const cache = await caches.open(SEARCH_CACHE_NAME);
    const hit = await cache.match(key);
    if (hit) return (await hit.json()) as TokenInfo[];
  } catch {
    // 缓存不可用 → 回源
  }
  const out = await oracle.tokens.search(q);
  try {
    const cache = await caches.open(SEARCH_CACHE_NAME);
    await cache.put(
      key,
      new Response(JSON.stringify(out), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${SEARCH_CACHE_TTL_S}`,
        },
      }),
    );
  } catch {
    // 写缓存失败不阻断
  }
  return out;
}

// 选币 autocomplete(P7.4.3):按关键词搜;返回 TokenInfo[](JSON 可序列化)。
export const listTokens = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ query: z.string() }))
  .handler(async ({ data }) => {
    const q = data.query.trim();
    tokenLog.debug("searchTokens: enter", { query: q, hasKey: !!env.COINGECKO_API_KEY });
    if (!q) return [];
    // 抛错兜底在 requireAuth 中间件集中打日志(带 userId),此处只表达业务。短 TTL 边缘缓存见 cachedSearch。
    const out = await cachedSearch(q);
    tokenLog.debug("searchTokens: ok", { query: q, count: out.length });
    // logo 不代理:search 是对 CGK 的 live pass-through,结果不写 store、无内部 id;而 /api/logo
    // 按内部 id 读 store(getById,不回源),未持有的搜索命中查不到 → 404 图裂。故直返上游 URL
    // (ADR 0008 记为已接受的尾巴)。topTokens 走 store 有 id,可代理;search 不行。
    return out;
  });

// 默认选币下拉(P7.4.5,空输入):市值 top-N;冷缓存兜底(单飞预热)由 tokens.topTokens 内部处理。
export const listTopTokens = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ limit: z.number().int().positive().max(200).optional() }).optional())
  .handler(async ({ data }) => {
    const limit = data?.limit ?? TOP_TOKENS_LIMIT;
    tokenLog.debug("topTokens: enter", { limit, hasKey: !!env.COINGECKO_API_KEY });
    const out = await oracle.tokens.topTokens(limit);
    tokenLog.debug("topTokens: ok", { count: out.length });
    // topTokens 读 store(listTopTokens 带内部 id),/api/logo 的 getById 能命中 → 可安全代理
    //(不同于 search:live 结果无内部 id、不在 store)。
    return out.map((t) => ({ ...t, logo: tokenLogoUrl(t) }));
  });

// 选中代币后取当前市价预填单价(P7.4.5,用户可改)。resolve(显式 identifier)→ priceOf(缓存/回源/写在 tokens 内)。
export const getTokenPrice = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ identifier: z.string().min(1) }))
  .handler(async ({ data }) => {
    tokenLog.debug("tokenPrice: enter", { identifier: data.identifier });
    const tokens = oracle.tokens;
    // symbol 不参与:显式 identifier 直接升格为 ref(resolve 内部短路)。
    const res = await tokens.resolve({ symbol: "", identifier: data.identifier });
    const hit = res.ref ? await tokens.priceOf(res.ref) : undefined;
    tokenLog.debug("tokenPrice: ok", { identifier: data.identifier, found: !!hit });
    return hit
      ? { unitPrice: hit.unitPrice, change24h: hit.change24h ?? null, asOf: hit.asOf }
      : null;
  });
