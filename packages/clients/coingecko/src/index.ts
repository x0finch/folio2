// @folio/coingecko-client —— SDK 式 CoinGecko 客户端(tokens + platforms 复用)。
// 对外只暴露 createCoinGeckoClient(带类型方法)+ 配置/错误/DTO 类型;低层 request 内部化。

export {
  type CoinGeckoClient,
  type CoinsMarketChartRangeParams,
  type CoinsMarketsParams,
  createCoinGeckoClient,
  type SimplePriceParams,
} from "./client";
export {
  CG_BASE_FREE,
  CG_BASE_PRO,
  type CoinGeckoConfig,
  CoinGeckoError,
  type CoinGeckoErrorCode,
  HEADER_DEMO,
  HEADER_PRO,
  parseRetryAfter,
  USER_AGENT,
} from "./http";
export type {
  AssetPlatform,
  CoinContract,
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
