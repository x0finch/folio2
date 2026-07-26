// @folio/oracle2-upstream-coingecko —— `@folio/oracle2` 契约的 CoinGecko 实现。
//
// **全仓只有本包认识 CoinGecko**(ADR 0023):端点、DTO、非 EVM slug 对照、symbol 策展表
// 全在这里;`@folio/oracle2` 的 dependencies 里没有任何 client。app 在装配时把
// `createCoinGeckoUpstream` 注进去,那是唯一同时认识两边的文件。
//
// 临时包名:#202 那片改名接管 `@folio/oracle-upstream-coingecko`。

export { NON_EVM_PLATFORMS, OVERRIDES, UPSTREAM_ID } from "./constants";
// 纯解析器另导出,便于按 fixture 单测与上层复用。
export {
  cgkRef,
  coinIdOf,
  parseContract,
  parseMarkets,
  parsePriceSeries,
  parseSearch,
  parseSimplePrice,
} from "./parse";
export { toRefIndexRows } from "./ref-index";
export { type CoinGeckoConfig, createCoinGeckoUpstream } from "./upstream";
