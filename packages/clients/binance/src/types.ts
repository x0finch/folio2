import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// Minimal response shapes (fields we read). Numbers arrive as strings to avoid float precision loss.

export interface BinanceCreds {
  readonly apiKey: string;
  readonly secret: string;
}

export const TickerPrice = Schema.Struct({
  symbol: maybe(Schema.String),
  price: maybe(Schema.String),
});
export type TickerPrice = typeof TickerPrice.Type;

export const SpotBalance = Schema.Struct({
  asset: maybe(Schema.String),
  free: maybe(Schema.String),
  locked: maybe(Schema.String),
});
export type SpotBalance = typeof SpotBalance.Type;

export const SpotAccount = Schema.Struct({ balances: maybe(Schema.Array(SpotBalance)) });
export type SpotAccount = typeof SpotAccount.Type;

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
  totalMarginBalance: maybe(Schema.String), // equity = wallet balance + unrealized PnL
  totalPositionInitialMargin: maybe(Schema.String),
  maxWithdrawAmount: maybe(Schema.String),
  positions: maybe(Schema.Array(FuturesPosition)),
});
export type FuturesAccount = typeof FuturesAccount.Type;

export const CoinmAsset = Schema.Struct({
  asset: maybe(Schema.String),
  marginBalance: maybe(Schema.String), // per-asset equity, in coin
  maxWithdrawAmount: maybe(Schema.String),
  positionInitialMargin: maybe(Schema.String),
});
export type CoinmAsset = typeof CoinmAsset.Type;

export const CoinmPosition = Schema.Struct({
  symbol: maybe(Schema.String),
  positionAmt: maybe(Schema.String), // contracts, not coin amount
  entryPrice: maybe(Schema.String),
  unrealizedProfit: maybe(Schema.String), // in coin
  leverage: maybe(Schema.String),
  notional: maybe(Schema.String), // in coin
  isolated: maybe(Schema.Boolean),
  positionInitialMargin: maybe(Schema.String),
});
export type CoinmPosition = typeof CoinmPosition.Type;

export const CoinmAccount = Schema.Struct({
  assets: maybe(Schema.Array(CoinmAsset)),
  positions: maybe(Schema.Array(CoinmPosition)),
});
export type CoinmAccount = typeof CoinmAccount.Type;

export const FundingAsset = Schema.Struct({
  asset: maybe(Schema.String),
  free: maybe(Schema.String),
  locked: maybe(Schema.String),
  freeze: maybe(Schema.String),
  withdrawing: maybe(Schema.String),
});
export type FundingAsset = typeof FundingAsset.Type;

export const EarnFlexibleRow = Schema.Struct({
  asset: maybe(Schema.String),
  totalAmount: maybe(Schema.String),
  latestAnnualPercentageRate: maybe(Schema.String), // floating APY as a fraction, e.g. "0.05"
});
export type EarnFlexibleRow = typeof EarnFlexibleRow.Type;

export const EarnLockedRow = Schema.Struct({
  asset: maybe(Schema.String),
  amount: maybe(Schema.String),
  apy: maybe(Schema.String), // fraction
  redeemDate: maybe(Schema.Union(Schema.Number, Schema.String)), // maturity, ms timestamp
});
export type EarnLockedRow = typeof EarnLockedRow.Type;

// Pagination envelope; internal only — callers get the collected rows.
export const EarnPage = <A, I>(row: Schema.Schema<A, I>) =>
  Schema.Struct({
    rows: maybe(Schema.Array(row)),
    total: maybe(Schema.Union(Schema.Number, Schema.String)),
  });
