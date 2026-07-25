import type { Tokens } from "@folio/oracle";
import {
  type BalanceLike,
  displayAssetRef,
  type TokenEnrichment,
  toEnrichment,
} from "../../tokens";

// 代币展示富化 / 预热助手(非 server fn,server-only)。被 portfolio/sync-deps 复用。

// 展示富化(cache-only,零网络):tokens.enrich 解析 + 整行读取;按行挂富化字段(缺则原样降级)。
// 孤儿(CGK 未收录)也出 name/providerLogo;pricesStale = 任一行价格过期/缺失(SWR:客户端据此触发刷新)。
export async function enrichBalances<T extends BalanceLike>(
  tokens: Tokens,
  balances: T[],
): Promise<{ rows: (T & TokenEnrichment)[]; pricesStale: boolean }> {
  // defi 行也做展示富化(H5 #120:抽屉协议行的 24h 聚合);估值现推路径不受影响(那里仍只走
  // balanceToAssetRef 的同质门)。
  const enriched = await tokens.enrich(balances.map(displayAssetRef));
  return {
    rows: balances.map((b, i) => {
      const e = enriched[i];
      return e ? { ...b, ...toEnrichment(e) } : b;
    }),
    pricesStale: enriched.some((e) => e?.priceStale),
  };
}

// 预热(写缓存,best-effort):tokens.warm 刷新 top-N + 逐行 lazy 解析(合约懒解析入缓存)。
// cron(waitUntil)与手动 sync 后调用。
export async function warmTokens(tokens: Tokens, balances: BalanceLike[]): Promise<void> {
  // 同 displayAssetRef 门:defi 行的解析/价格也预热,协议行 24h 才有数据可用。
  await tokens.warm(balances.map(displayAssetRef));
}
