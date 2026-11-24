// CoinGecko implementation of the `@folio/oracle-basic` contract; the only package that knows CoinGecko.

export { NON_EVM_PLATFORMS, UPSTREAM_ID } from "./constants";
export { coinGeckoNamerLayer } from "./layer";
// Pure parsers are exported for fixture tests.
export {
  cgkRef,
  coinIdOf,
  parseMarkets,
  parsePriceSeries,
  parseSearch,
  parseSimplePrice,
} from "./parse";
export { toRefIndexRows } from "./ref-index";
export type { CoinGeckoConfig } from "./upstream";
export { coinGeckoUpstreamLayers } from "./upstreams";
