// @folio/oracle-source-coingecko —— `@folio/oracle-basic` 契约的 CoinGecko 实现(`TokenSource`)。
// 纯解析器另导出,便于上层(P7.3/P7.4)按需复用。

// 平台与汇率的 CoinGecko source 都已搬进 oracle2(#202b)—— 本包只剩代币那一面。
export {
  parseAssetPlatforms,
  parseContract,
  parseMarkets,
  parsePriceSeries,
  parseSearch,
  parseSimplePrice,
} from "./parse";
export type { CoinGeckoConfig } from "./token";
export { createCoinGeckoSource } from "./token";
