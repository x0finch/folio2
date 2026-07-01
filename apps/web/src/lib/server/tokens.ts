import { env } from "cloudflare:workers";
import { createTokenStore } from "@folio/db";
import {
  type CoinId,
  OVERRIDES,
  PRICE_TTL_MS,
  type ResolveDeps,
  refKey,
  refreshWarm,
  resolveAsset,
  TOP_COINS_LIMIT,
  type TokenRef,
} from "@folio/tokens";
import { createCoinGeckoSource } from "@folio/tokens-coingecko";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../require-auth";
import { type BalanceLike, balanceToAssetRef, type TokenEnrichment, toEnrichment } from "../tokens";

// 当前数据源(P7.4 固定 coingecko;切源是 per-user 设置,留后)。
const SOURCE = "coingecko" as const;

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 选币 autocomplete(P7.4.3):按关键词搜 CoinGecko;返回 TokenInfo[](ref/symbol/name/logo,JSON 可序列化)。
export const searchCoins = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ query: z.string() }))
  .handler(async ({ data }) => {
    const q = data.query.trim();
    tokenLog.debug("searchCoins: enter", { query: q, hasKey: !!env.COINGECKO_API_KEY });
    if (!q) return [];
    try {
      const out = await buildTokenDeps(env).source.searchCoins(q);
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

// 冷缓存预热的进程内单飞:多个用户同时命中空 warm 时只发一次预热(避免 thundering herd)。
// CF isolate 级别;跨 isolate 各自一份即可,目的只是压掉同一 isolate 的并发风暴。
let warmInFlight: Promise<unknown> | null = null;

// 默认选币下拉(P7.4.5,空输入):按市值 top-N 返回 warm 缓存(零网络)。
// 冷缓存(未预热)兜底:单飞地预热一次再读;预热失败则返回当前(可能为空),UI 走搜索/自定义录入。
export const topCoins = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ limit: z.number().int().positive().max(200).optional() }).optional())
  .handler(async ({ data }) => {
    const limit = data?.limit ?? TOP_COINS_LIMIT;
    const deps = buildTokenDeps(env);
    tokenLog.debug("topCoins: enter", { limit, hasKey: !!env.COINGECKO_API_KEY });
    const top = await deps.store.listTopTokens(limit);
    tokenLog.debug("topCoins: warm cache read", { cached: top.length });
    if (top.length > 0) return top;
    // 冷缓存:预热一次(单飞),再读。预热是读路径的副作用,仅未预热时触发。
    try {
      tokenLog.info("topCoins: cold cache, warming");
      warmInFlight ??= refreshWarm(deps, { now: Date.now() }).finally(() => {
        warmInFlight = null;
      });
      await warmInFlight;
    } catch (err) {
      tokenLog.error("topCoins: warm failed", {
        error: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string })?.code,
      });
      // 预热失败(限流/网络)不阻断:返回空,UI 显搜索/自定义录入。
    }
    const after = await deps.store.listTopTokens(limit);
    tokenLog.debug("topCoins: ok", { count: after.length });
    return after;
  });

// 选中代币后取当前市价预填单价(P7.4.5,用户可改)。缓存优先(零网络),miss 则 `/simple/price`
// 取一次并回写缓存。命中返回 { unitPrice, change24h, asOf },未收录/无价返回 null → UI 不预填。
export const coinPrice = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ coinId: z.string().min(1) }))
  .handler(async ({ data }) => {
    const deps = buildTokenDeps(env);
    const ref: TokenRef = { source: SOURCE, coinId: data.coinId as CoinId };
    tokenLog.debug("coinPrice: enter", { coinId: data.coinId });
    try {
      const cached = (await deps.store.getPrices([ref])).get(refKey(ref));
      const hit = cached ?? (await fetchAndCachePrice(deps, ref));
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

async function fetchAndCachePrice(deps: ResolveDeps, ref: TokenRef) {
  const p = (await deps.source.fetchPrices([ref])).get(refKey(ref));
  if (p) await deps.store.putPrices([p], PRICE_TTL_MS);
  return p;
}

// 代币参考层依赖:CoinGecko 源 + D1 store(按 source 分桶)+ 撞名覆盖表。
// 无 key 也能跑(free 档限流低);bindings 经各调用方传入。
export function buildTokenDeps(bindings: Cloudflare.Env): ResolveDeps {
  return {
    source: createCoinGeckoSource({ apiKey: bindings.COINGECKO_API_KEY || undefined }),
    store: createTokenStore(bindings, { source: SOURCE }),
    overrides: OVERRIDES,
  };
}

// 展示富化(cache-only,零网络):resolve→ref→批量 getInfo/getPrices→每行挂富化字段。
// 缓存没有(未预热/长尾)→ 原样返回(降级:UI 显 symbol + provider usdValue)。
export async function enrichBalances<T extends BalanceLike>(
  deps: ResolveDeps,
  balances: T[],
): Promise<(T & TokenEnrichment)[]> {
  const refs = await Promise.all(
    balances.map(async (b) => {
      const asset = balanceToAssetRef(b);
      if (!asset) return null;
      return (await resolveAsset(asset, deps, { lazy: false })).ref;
    }),
  );
  const present = refs.filter((r) => r !== null);
  const [infos, prices] = await Promise.all([
    deps.store.getInfo(present),
    deps.store.getPrices(present),
  ]);
  return balances.map((b, i) => {
    const ref = refs[i];
    if (!ref) return b;
    return { ...b, ...toEnrichment(infos.get(refKey(ref)), prices.get(refKey(ref))) };
  });
}

// 预热(写缓存,lazy 会按需 fetchByContract):refreshWarm + 对 spot/manual 行逐个 resolveAsset。
// 顺序执行,尊重 CGK free 档限流;失败不抛(best-effort)。cron(waitUntil)与手动 sync 后调用。
export async function warmTokens(
  deps: ResolveDeps,
  balances: BalanceLike[],
  now: number,
): Promise<void> {
  try {
    await refreshWarm(deps, { now });
    for (const b of balances) {
      const asset = balanceToAssetRef(b);
      if (asset) await resolveAsset(asset, deps, { lazy: true });
    }
  } catch {
    // 预热失败不影响主流程(同步/展示);下次再试。
  }
}
