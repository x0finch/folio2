import { env } from "cloudflare:workers";
import { TOP_TOKENS_LIMIT, tokenTicket, type UpstreamToken } from "@folio/oracle2";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { TokenOption } from "../token-option";
import { oracleFor } from "./internal/oracle2";
import { requireAuth } from "./internal/require-auth";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 选币的三个 server fn(#202b:整条搬到新参考层)。
//
// **点中不建行。** 三个都只是读:搜、列、取价。代币行是提交表单时由 mint 建的 —— 用户在
// 下拉里划过十个币不该在库里留十行垃圾。因此这里给出去的不是内部 id(那时还没有),
// 而是一张**票**:base64url 编过的 tokenRef,前端原样搬运(见 lib/token-option.ts)。

// 上游结果 → 下拉项。**logo 是上游直链,不走 folio 代理**:代理端点按内部代币行 id 读库
// (`/api/logo/token/$id`),而这些币还没有行。ADR 0008 早就把搜索这一档记成已接受的尾巴,
// 这里只是让默认列跟它一致 —— 而默认列恰好是最无所谓的那一档:市值前 N 名人人都一样,
// 浏览器去 CoinGecko 取这几张图不泄露任何人持有什么。
const toOption = (t: UpstreamToken): TokenOption => ({
  ticket: tokenTicket.encode(t.ref),
  symbol: t.symbol,
  name: t.name,
  logo: t.logo,
});

// 搜索结果短 TTL 边缘缓存(Workers Cache;搜索结果与用户无关 → 可跨用户共享)。上游的 /search 慢且限流
// → 免重复词反复回源。key 用规范化 query 合成 GET 请求。dev(Miniflare)Cache 可能不持久 → 靠客户端
// debounce/最小长度兜。缓存读写失败一律不阻断,退化为直接回源。
const SEARCH_CACHE_TTL_S = 300;
const SEARCH_CACHE_NAME = "folio-token-search";

async function cachedSearch(userId: string, q: string): Promise<TokenOption[]> {
  const key = new Request(`https://folio.internal/token-search?q=${encodeURIComponent(q)}`);
  try {
    const cache = await caches.open(SEARCH_CACHE_NAME);
    const hit = await cache.match(key);
    if (hit) return (await hit.json()) as TokenOption[];
  } catch {
    // 缓存不可用 → 回源
  }
  // 走 `oracleFor(userId)` 只是因为参考层的门面就长这样;搜索本身**不碰这个用户的任何数据**
  // (恒回源、不写库),所以结果跨用户共享缓存是安全的。
  const out = (await oracleFor(userId).tokens.search(q)).map(toOption);
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

// 选币 autocomplete:按关键词搜。
export const listTokens = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ query: z.string() }))
  .handler(async ({ data, context }): Promise<TokenOption[]> => {
    const q = data.query.trim();
    tokenLog.debug("searchTokens: enter", { query: q, hasKey: !!env.COINGECKO_API_KEY });
    if (!q) return [];
    // 抛错兜底在 requireAuth 中间件集中打日志(带 userId),此处只表达业务。
    const out = await cachedSearch(context.userId, q);
    tokenLog.debug("searchTokens: ok", { query: q, count: out.length });
    return out;
  });

// 默认选币下拉(空输入):市值 top-N,走这个用户的目录缓存(冷则预热一次,见 warmMarkets)。
export const listTopTokens = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ limit: z.number().int().positive().max(200).optional() }).optional())
  .handler(async ({ data, context }): Promise<TokenOption[]> => {
    const limit = data?.limit ?? TOP_TOKENS_LIMIT;
    tokenLog.debug("topTokens: enter", { limit, hasKey: !!env.COINGECKO_API_KEY });
    const out = (await oracleFor(context.userId).tokens.topTokens(limit)).map(toOption);
    tokenLog.debug("topTokens: ok", { count: out.length });
    return out;
  });

// 选中之后取现价预填单价(用户可改)。**票解不开就当没选** —— 它是从网络上来的。
export const getTokenPrice = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ ticket: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const ref = tokenTicket.decode(data.ticket);
    if (!ref) {
      tokenLog.debug("tokenPrice: bad ticket");
      return null;
    }
    const hit = await oracleFor(context.userId).tokens.priceByRef(ref);
    tokenLog.debug("tokenPrice: ok", { found: !!hit });
    return hit
      ? { unitPrice: hit.unitPrice, change24h: hit.change24h ?? null, asOf: hit.asOf }
      : null;
  });
