import { env } from "cloudflare:workers";
import { createTokenStore } from "@folio/db";
import { OVERRIDES, type ResolveDeps, refKey, refreshWarm, resolveAsset } from "@folio/tokens";
import { CoinGeckoSource } from "@folio/tokens-coingecko";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../require-auth";
import { type BalanceLike, balanceToAssetRef, type TokenEnrichment, toEnrichment } from "../tokens";

// 当前数据源(P7.4 固定 coingecko;切源是 per-user 设置,留后)。
const SOURCE = "coingecko" as const;

// 选币 autocomplete(P7.4.3):按关键词搜 CoinGecko;返回 TokenInfo[](ref/symbol/name/logo,JSON 可序列化)。
export const searchCoins = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ query: z.string() }))
  .handler(async ({ data }) => {
    const q = data.query.trim();
    if (!q) return [];
    return buildTokenDeps(env).source.searchCoins(q);
  });

// 代币参考层依赖:CoinGecko 源 + D1 store(按 source 分桶)+ 撞名覆盖表。
// 无 key 也能跑(free 档限流低);bindings 经各调用方传入。
export function buildTokenDeps(bindings: Cloudflare.Env): ResolveDeps {
  return {
    source: new CoinGeckoSource({ apiKey: bindings.COINGECKO_API_KEY || undefined }),
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
