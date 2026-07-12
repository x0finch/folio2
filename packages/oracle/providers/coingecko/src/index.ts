// @folio/oracle-provider-coingecko —— `@folio/oracle-basic` 契约的 CoinGecko 实现(`TokenProvider`)。
// 纯解析器另导出,便于上层(P7.3/P7.4)按需复用。

// 平台 / 汇率的 CoinGecko source(折入自 @folio/platforms、@folio/fx,#72)。
export { createCoinGeckoFxSource } from "./fx-source";
export {
  parseAssetPlatforms,
  parseContract,
  parseMarkets,
  parseRetryAfter,
  parseSearch,
  parseSimplePrice,
} from "./parse";
export { createCoinGeckoPlatformSource } from "./platform-source";
export type { CoinGeckoConfig } from "./provider";
export { createCoinGeckoProvider } from "./provider";
export { coinGeckoVendor } from "./vendor";
