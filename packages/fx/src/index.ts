// @folio/fx —— 展示币种 + 汇率(FX)。契约 + CoinGecko 源 + 服务,单包(CoinGecko 是唯一源)。

export { createCoinGeckoFxSource } from "./coingecko";
export { type CreateFxRatesConfig, createFxRates } from "./service";
export {
  type Currency,
  DEFAULT_CURRENCY,
  FxError,
  type FxErrorCode,
  type FxRates,
  type FxRow,
  type FxSource,
  type FxStore,
  SUPPORTED_CURRENCIES,
} from "./types";
