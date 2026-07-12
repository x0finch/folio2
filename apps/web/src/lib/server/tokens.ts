import { env } from "cloudflare:workers";
import { TOP_TOKENS_LIMIT, type Tokens } from "@folio/tokens";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { tokenLogoUrl } from "../logo";
import { requireAuth } from "../require-auth";
import { type BalanceLike, balanceToAssetRef, type TokenEnrichment, toEnrichment } from "../tokens";
import { db } from "./db";
import { oracle } from "./oracle";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 选币 autocomplete(P7.4.3):按关键词搜;返回 TokenInfo[](JSON 可序列化)。
export const searchTokens = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ query: z.string() }))
  .handler(async ({ data }) => {
    const q = data.query.trim();
    tokenLog.debug("searchTokens: enter", { query: q, hasKey: !!env.COINGECKO_API_KEY });
    if (!q) return [];
    // 抛错兜底在 requireAuth 中间件集中打日志(带 userId),此处只表达业务。
    const out = await oracle.tokens.search(q);
    tokenLog.debug("searchTokens: ok", { query: q, count: out.length });
    // logo 不代理:search 是对 CGK 的 live pass-through,结果不写 store、无内部 id;而 /api/logo
    // 按内部 id 读 store(getById,不回源),未持有的搜索命中查不到 → 404 图裂。故直返上游 URL
    // (ADR 0008 记为已接受的尾巴)。topTokens 走 store 有 id,可代理;search 不行。
    return out;
  });

// 默认选币下拉(P7.4.5,空输入):市值 top-N;冷缓存兜底(单飞预热)由 tokens.topTokens 内部处理。
export const topTokens = createServerFn({ method: "GET" })
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
export const tokenPrice = createServerFn({ method: "GET" })
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

// 展示富化(cache-only,零网络):tokens.enrich 解析 + 整行读取;按行挂富化字段(缺则原样降级)。
// 孤儿(CGK 未收录)也出 name/providerLogo;pricesStale = 任一行价格过期/缺失(SWR:客户端据此触发刷新)。
export async function enrichBalances<T extends BalanceLike>(
  tokens: Tokens,
  balances: T[],
): Promise<{ rows: (T & TokenEnrichment)[]; pricesStale: boolean }> {
  const enriched = await tokens.enrich(balances.map(balanceToAssetRef));
  return {
    rows: balances.map((b, i) => {
      const e = enriched[i];
      return e ? { ...b, ...toEnrichment(e) } : b;
    }),
    pricesStale: enriched.some((e) => e?.priceStale),
  };
}

// SWR 刷价(客户端在看到 pricesStale 后调用):对该用户最新快照的全部持仓,凡解析出 ref 且价
// stale/缺失者一次批量回源写回。服务端自算 stale 集(不信客户端入参);失败静默(下次再试)。
export const refreshStalePrices = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const snapshots = await db.getLatestSnapshotByUser(context.userId);
    const assets = snapshots.flatMap((s) => s.balances).map(balanceToAssetRef);
    const refreshed = await oracle.tokens.refreshStalePrices(assets);
    tokenLog.info("stale prices refreshed", { refreshed });
    return { refreshed };
  });

// 预热(写缓存,best-effort):tokens.warm 刷新 top-N + 逐行 lazy 解析(合约懒解析入缓存)。
// cron(waitUntil)与手动 sync 后调用。
export async function warmTokens(tokens: Tokens, balances: BalanceLike[]): Promise<void> {
  await tokens.warm(balances.map(balanceToAssetRef));
}
