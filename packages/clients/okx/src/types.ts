import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// Minimal shapes of the OKX v5 endpoint responses (only the fields used). Types derive from the schema.
// Number fields are all `string`, and `code` is also a string ("0" = OK), unlike Bybit's numeric retCode; the difference bites, so the types pin it.

export interface OkxCreds {
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string; // OKX has this, Bybit / binance do not
}

// Outer envelope shared by all responses; the business code is checked at this layer (HTTP 200 + code != "0" is also a failure).
const envelope = {
  code: maybe(Schema.String), // a string, "0" = OK
  msg: maybe(Schema.String),
};

export const OkxEnvelope = Schema.Struct(envelope);
export type OkxEnvelope = typeof OkxEnvelope.Type;

// Trading account /api/v5/account/balance
export const OkxDetail = Schema.Struct({
  ccy: maybe(Schema.String),
  eq: maybe(Schema.String), // token equity (includes contract uPnL when used as margin): only used to derive a market price, not as holdings
  eqUsd: maybe(Schema.String), // USD value of eq: eqUsd/eq = market price (excluding uPnL)
  cashBal: maybe(Schema.String), // cash balance (excluding contract uPnL): the holdings basis
  frozenBal: maybe(Schema.String), // frozen balance (native token, held by orders / borrowing)
});
export type OkxDetail = typeof OkxDetail.Type;

export const OkxBalanceResponse = Schema.Struct({
  ...envelope,
  data: maybe(Schema.Array(Schema.Struct({ details: maybe(Schema.Array(OkxDetail)) }))),
});
export type OkxBalanceResponse = typeof OkxBalanceResponse.Type;

// Funding account /api/v5/asset/balances (data is a flat array, not wrapped in details)
export const OkxFundingAsset = Schema.Struct({
  ccy: maybe(Schema.String),
  bal: maybe(Schema.String), // total balance (including frozen): the holdings basis
});
export type OkxFundingAsset = typeof OkxFundingAsset.Type;

export const OkxFundingResponse = Schema.Struct({
  ...envelope,
  data: maybe(Schema.Array(OkxFundingAsset)),
});
export type OkxFundingResponse = typeof OkxFundingResponse.Type;

// Earn: flexible lending /api/v5/finance/savings/balance
export const OkxSavingsRow = Schema.Struct({
  ccy: maybe(Schema.String),
  amt: maybe(Schema.String), // lent principal (holdings basis)
  rate: maybe(Schema.String), // annual APY (decimal)
});
export type OkxSavingsRow = typeof OkxSavingsRow.Type;

export const OkxSavingsResponse = Schema.Struct({
  ...envelope,
  data: maybe(Schema.Array(OkxSavingsRow)),
});
export type OkxSavingsResponse = typeof OkxSavingsResponse.Type;

// Earn: active on-chain orders /api/v5/finance/staking-defi/orders-active
export const OkxStakingInvest = Schema.Struct({
  ccy: maybe(Schema.String),
  amt: maybe(Schema.String),
});
export type OkxStakingInvest = typeof OkxStakingInvest.Type;

export const OkxStakingOrder = Schema.Struct({
  ccy: maybe(Schema.String),
  protocol: maybe(Schema.String),
  apy: maybe(Schema.String), // annual APY (decimal)
  investData: maybe(Schema.Array(OkxStakingInvest)),
});
export type OkxStakingOrder = typeof OkxStakingOrder.Type;

export const OkxStakingResponse = Schema.Struct({
  ...envelope,
  data: maybe(Schema.Array(OkxStakingOrder)),
});
export type OkxStakingResponse = typeof OkxStakingResponse.Type;

// Authoritative USD per bucket /api/v5/asset/asset-valuation
export const OkxValuationDetails = Schema.Struct({
  classic: maybe(Schema.String),
  earn: maybe(Schema.String),
  funding: maybe(Schema.String),
  trading: maybe(Schema.String),
});
export type OkxValuationDetails = typeof OkxValuationDetails.Type;

export const OkxValuationResponse = Schema.Struct({
  ...envelope,
  data: maybe(
    Schema.Array(
      Schema.Struct({ totalBal: maybe(Schema.String), details: maybe(OkxValuationDetails) }),
    ),
  ),
});
export type OkxValuationResponse = typeof OkxValuationResponse.Type;

// Contract positions /api/v5/account/positions
export const OkxPositionsResponse = Schema.Struct({
  ...envelope,
  data: maybe(
    Schema.Array(
      Schema.Struct({
        instId: maybe(Schema.String),
        pos: maybe(Schema.String),
        upl: maybe(Schema.String),
      }),
    ),
  ),
});
export type OkxPositionsResponse = typeof OkxPositionsResponse.Type;
