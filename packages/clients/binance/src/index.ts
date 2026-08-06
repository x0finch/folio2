// @folio/binance-client —— Binance REST 的请求层(签名 / 限频 / 翻页 / 多 host / 错误归类)。
//
// 只跟上游说话,**不带任何 folio 语义** —— `parse*` 那批纯函数、估值、note 文案、`BalanceProvider`
// 实现都在 connector 适配层(ADR 0036)。也因此本包**不依赖 `@folio/connectors-basic`**:
// 上游的错误怎么映射成 connector 的错误,是适配层的活。
//
// 用法:`Effect.provide(BinanceClient.layer({ apiBase, fapiBase, dapiBase }))`,业务里 `yield* BinanceClient`
// 取服务。三个 base 是不透明整串(代理覆盖 #264 由调用方传,client 不读 env)。

export { BinanceClient, type BinanceClientApi, type BinanceConfig, make } from "./client";
export {
  BINANCE_API_BASE,
  BINANCE_DELIVERY_API_BASE,
  BINANCE_FUTURES_API_BASE,
} from "./constants";
export {
  BinanceAuthError,
  type BinanceError,
  BinanceParseError,
  BinanceRateLimitError,
  BinanceUpstreamError,
  isRetryable,
} from "./errors";
export type {
  BinanceCreds,
  CoinmAccount,
  CoinmAsset,
  CoinmPosition,
  EarnFlexibleRow,
  EarnLockedRow,
  FundingAsset,
  FuturesAccount,
  FuturesPosition,
  SpotAccount,
  SpotBalance,
  TickerPrice,
} from "./types";
