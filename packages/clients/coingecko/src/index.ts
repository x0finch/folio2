// @folio/coingecko-client —— SDK 式 CoinGecko 客户端(tokens + platforms 复用)。
// 对外只暴露 createCoinGeckoClient(带类型方法)+ 配置/错误/DTO 类型;传输层内部化。

export {
  type CoinGeckoClient,
  CoinGeckoError,
  type CoinGeckoErrorCode,
  type CoinsMarketChartRangeParams,
  type CoinsMarketsParams,
  createCoinGeckoClient,
  type SimplePriceParams,
} from "./client";
export { CG_BASE_FREE, CG_BASE_PRO, HEADER_DEMO, HEADER_PRO, USER_AGENT } from "./constants";
export type {
  AssetPlatform,
  CoinContract,
  CoinGeckoConfig,
  CoinListItem,
  DerivativesExchange,
  Exchange,
  ExchangeRateEntry,
  ExchangeRates,
  MarketChartRange,
  MarketCoin,
  SearchCoin,
  SearchResult,
  SimplePriceMap,
} from "./types";
