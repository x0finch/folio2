// @folio/oracle-source-coingecko —— `@folio/oracle-basic` 契约的 CoinGecko 实现(`TokenSource`)。
// 纯解析器另导出,便于上层(P7.3/P7.4)按需复用。

// 平台 / 汇率的 CoinGecko source(折入自 @folio/platforms、@folio/fx,#72)。
export { createCoinGeckoFxSource } from "./fx";
export {
  parseAssetPlatforms,
  parseContract,
  parseMarkets,
  parsePriceSeries,
  parseRetryAfter,
  parseSearch,
  parseSimplePrice,
} from "./parse";
export { createCoinGeckoPlatformSource } from "./platform";
export type { CoinGeckoConfig } from "./token";
export { createCoinGeckoSource } from "./token";
