import { env } from "cloudflare:workers";
import { createTokenStore } from "@folio/db";
import { createTokens, TOP_COINS_LIMIT, type Tokens } from "@folio/tokens";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../require-auth";
import { type BalanceLike, balanceToAssetRef, type TokenEnrichment, toEnrichment } from "../tokens";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 组装 tokens 实例:默认 provider(CoinGecko)+ D1 store(store 实现经回调注入,tokens 不依赖 @folio/db)。
export function buildTokens(bindings: Cloudflare.Env): Tokens {
  return createTokens({
    apiKey: bindings.COINGECKO_API_KEY || undefined,
    createStore: (source) => createTokenStore(bindings, { source }),
  });
}

// 选币 autocomplete(P7.4.3):按关键词搜;返回 TokenInfo[](JSON 可序列化)。
export const searchCoins = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ query: z.string() }))
  .handler(async ({ data }) => {
    const q = data.query.trim();
    tokenLog.debug("searchCoins: enter", { query: q, hasKey: !!env.COINGECKO_API_KEY });
    if (!q) return [];
    try {
      const out = await buildTokens(env).search(q);
      tokenLog.debug("searchCoins: ok", { query: q, count: out.length });
      return out;
    } catch (err) {
      tokenLog.error("searchCoins: failed", {
        query: q,
        error: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string })?.code,
      });
      throw err;
    }
  });

// 默认选币下拉(P7.4.5,空输入):市值 top-N;冷缓存兜底(单飞预热)由 tokens.topTokens 内部处理。
export const topCoins = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ limit: z.number().int().positive().max(200).optional() }).optional())
  .handler(async ({ data }) => {
    const limit = data?.limit ?? TOP_COINS_LIMIT;
    tokenLog.debug("topCoins: enter", { limit, hasKey: !!env.COINGECKO_API_KEY });
    const out = await buildTokens(env).topTokens(limit);
    tokenLog.debug("topCoins: ok", { count: out.length });
    return out;
  });

// 选中代币后取当前市价预填单价(P7.4.5,用户可改)。resolve(显式 coinId)→ priceOf(缓存/回源/写在 tokens 内)。
export const coinPrice = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ coinId: z.string().min(1) }))
  .handler(async ({ data }) => {
    tokenLog.debug("coinPrice: enter", { coinId: data.coinId });
    try {
      const tokens = buildTokens(env);
      // symbol 不参与:显式 coinId 直接升格为 ref(resolve 内部短路)。
      const res = await tokens.resolve({ symbol: "", coinId: data.coinId });
      const hit = res.ref ? await tokens.priceOf(res.ref) : undefined;
      tokenLog.debug("coinPrice: ok", { coinId: data.coinId, found: !!hit });
      return hit
        ? { unitPrice: hit.unitPrice, change24h: hit.change24h ?? null, asOf: hit.asOf }
        : null;
    } catch (err) {
      tokenLog.error("coinPrice: failed", {
        coinId: data.coinId,
        error: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string })?.code,
      });
      throw err;
    }
  });

// 展示富化(cache-only,零网络):tokens.enrich 解析 + 批量取 info/price;按行挂富化字段(缺则原样降级)。
export async function enrichBalances<T extends BalanceLike>(
  tokens: Tokens,
  balances: T[],
): Promise<(T & TokenEnrichment)[]> {
  const enriched = await tokens.enrich(balances.map(balanceToAssetRef));
  return balances.map((b, i) => {
    const e = enriched[i];
    return e?.ref ? { ...b, ...toEnrichment(e.info, e.price) } : b;
  });
}

// 预热(写缓存,best-effort):tokens.warm 刷新 top-N + 逐行 lazy 解析(合约懒解析入缓存)。
// cron(waitUntil)与手动 sync 后调用。
export async function warmTokens(tokens: Tokens, balances: BalanceLike[]): Promise<void> {
  await tokens.warm(balances.map(balanceToAssetRef));
}
