// @folio/coingecko-client: request layer for CoinGecko v3. Talks only to the upstream, no folio semantics.
// No retry of its own: the caller adds `Effect.retry(policy)` outside, so the gate sits inside the retry. No `sleep` injection (tests use
// `TestClock`). Errors are the shared four (`Upstream*Error`); 401/403 classify as credentials, which does not change retry behaviour.
export {
  CoinGeckoClient,
  type CoinGeckoClientApi,
  type CoinGeckoConfig,
  type CoinsMarketChartRangeParams,
  type CoinsMarketsParams,
  make,
  type SimplePriceParams,
} from "./client";
export { CG_BASE_FREE, CG_BASE_PRO, USER_AGENT } from "./constants";
export type {
  AssetPlatform,
  CoinContract,
  CoinListItem,
  DerivativesExchange,
  Exchange,
  ExchangeRates,
  MarketChartRange,
  MarketCoin,
  SearchResult,
  SimplePriceMap,
} from "./types";
