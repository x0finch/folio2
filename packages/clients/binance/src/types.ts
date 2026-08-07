import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// Binance 各端点响应的**最小形状**(仅取用到的字段)。字段一个没动 —— 换的是「谁说了算」:
// 以前是 `interface` + 一次 `as`(声明而已,运行时没人查),现在是 schema,类型从它推出来。
//
// 字段几乎全是 `string`:binance 用字符串传数字(避免 IEEE754 精度问题)。转数字归适配层。

export interface BinanceCreds {
  readonly apiKey: string;
  readonly secret: string;
}

// —— 公开:全市场价 ——
export const TickerPrice = Schema.Struct({
  symbol: maybe(Schema.String),
  price: maybe(Schema.String),
});
export type TickerPrice = typeof TickerPrice.Type;

// —— 现货账户(/api/v3/account)——
export const SpotBalance = Schema.Struct({
  asset: maybe(Schema.String),
  free: maybe(Schema.String),
  locked: maybe(Schema.String),
});
export type SpotBalance = typeof SpotBalance.Type;

export const SpotAccount = Schema.Struct({ balances: maybe(Schema.Array(SpotBalance)) });
export type SpotAccount = typeof SpotAccount.Type;

// —— U 本位合约账户(fapi /fapi/v2/account)——
export const FuturesPosition = Schema.Struct({
  symbol: maybe(Schema.String),
  positionAmt: maybe(Schema.String),
  entryPrice: maybe(Schema.String),
  unrealizedProfit: maybe(Schema.String),
  leverage: maybe(Schema.String),
  notional: maybe(Schema.String),
  isolated: maybe(Schema.Boolean),
  positionInitialMargin: maybe(Schema.String),
});
export type FuturesPosition = typeof FuturesPosition.Type;

export const FuturesAccount = Schema.Struct({
  totalMarginBalance: maybe(Schema.String), // 账户权益 = 钱包余额 + 未实现盈亏
  totalPositionInitialMargin: maybe(Schema.String),
  maxWithdrawAmount: maybe(Schema.String),
  positions: maybe(Schema.Array(FuturesPosition)),
});
export type FuturesAccount = typeof FuturesAccount.Type;

// —— 币本位合约账户(dapi /dapi/v1/account)——
export const CoinmAsset = Schema.Struct({
  asset: maybe(Schema.String),
  marginBalance: maybe(Schema.String), // per-asset 权益(币计价)
  maxWithdrawAmount: maybe(Schema.String),
  positionInitialMargin: maybe(Schema.String),
});
export type CoinmAsset = typeof CoinmAsset.Type;

export const CoinmPosition = Schema.Struct({
  symbol: maybe(Schema.String),
  positionAmt: maybe(Schema.String), // 张数(cont),非币量
  entryPrice: maybe(Schema.String),
  unrealizedProfit: maybe(Schema.String), // 币计价
  leverage: maybe(Schema.String),
  notional: maybe(Schema.String), // 币计价
  isolated: maybe(Schema.Boolean),
  positionInitialMargin: maybe(Schema.String),
});
export type CoinmPosition = typeof CoinmPosition.Type;

export const CoinmAccount = Schema.Struct({
  assets: maybe(Schema.Array(CoinmAsset)),
  positions: maybe(Schema.Array(CoinmPosition)),
});
export type CoinmAccount = typeof CoinmAccount.Type;

// —— 资金账户(/sapi/v1/asset/get-funding-asset,POST SIGNED)——
export const FundingAsset = Schema.Struct({
  asset: maybe(Schema.String),
  free: maybe(Schema.String),
  locked: maybe(Schema.String),
  freeze: maybe(Schema.String),
  withdrawing: maybe(Schema.String),
});
export type FundingAsset = typeof FundingAsset.Type;

// —— 理财(Simple Earn)——
export const EarnFlexibleRow = Schema.Struct({
  asset: maybe(Schema.String),
  totalAmount: maybe(Schema.String),
  latestAnnualPercentageRate: maybe(Schema.String), // 活期浮动 APY(小数,如 "0.05")
});
export type EarnFlexibleRow = typeof EarnFlexibleRow.Type;

export const EarnLockedRow = Schema.Struct({
  asset: maybe(Schema.String),
  amount: maybe(Schema.String),
  apy: maybe(Schema.String), // 定期 APY(小数)
  redeemDate: maybe(Schema.Union(Schema.Number, Schema.String)), // 到期(ms 时间戳)
});
export type EarnLockedRow = typeof EarnLockedRow.Type;

// position 端点的翻页信封。**只在 client 内部用** —— 出口给的是收全了的行数组,
// 调用方不必知道翻过页(老 provider 里 `fetchEarnRows` 就在做这件事)。
export const EarnPage = <A, I>(row: Schema.Schema<A, I>) =>
  Schema.Struct({
    rows: maybe(Schema.Array(row)),
    total: maybe(Schema.Union(Schema.Number, Schema.String)),
  });
