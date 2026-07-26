import type { AssetRef, Tokens } from "@folio/oracle";
import {
  type BalanceLike,
  displayAssetRef,
  type TokenEnrichment,
  toEnrichment,
} from "../../tokens";
import { connectorPlatformMeta } from "./connector-platform";

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
//
// **这是唯一会拿合约去反查上游的路径**(展示富化恒 cache-only)。所以只在这里告诉参考层
// 「这笔持仓在哪条链上」—— 它自己分辨不出 `evm:1/0xa0b8…` 与 `binance/USDC`(文法收窄的代价),
// 而这边知道:平台由 provider 直接报(#193),链/场馆走下面那条 connector 级联。
// 不给 chain 的行(场馆、手记)照旧掉回 symbol 消歧。
export async function warmTokens(tokens: Tokens, balances: BalanceLike[]): Promise<void> {
  // 同 displayAssetRef 门:defi 行的解析/价格也预热,协议行 24h 才有数据可用。
  await tokens.warm(balances.map(withChain));
}

// 平台键是链还是场馆:**先问 connector** —— 认得这个键的,name+logo 就由它的 manifest 给
// (场馆恒是 connectorId 自己;链 slug 与同名连接器撞的那几条也走这条),不是要去查合约的链;
// 认不得的(`evm:<chainId>`)才是交给平台层 resolve 的链键。与读路径装饰同一条级联,不另立判据。
function withChain(b: BalanceLike): AssetRef | null {
  const ref = displayAssetRef(b);
  if (!ref) return null;
  const chain = b.platform && !connectorPlatformMeta(b.platform) ? b.platform : undefined;
  return chain ? { ...ref, chain } : ref;
}
