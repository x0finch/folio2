import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// Minimal shapes of the Bybit v5 endpoint responses (only the fields used). Types derive from the schema.
// Number fields are all `string` (Bybit sends numbers as strings), while `retCode` is a number (0 = OK), unlike OKX's string code; the difference bites, so the types pin it.

export interface BybitCreds {
  readonly apiKey: string;
  readonly secret: string;
}

// Outer envelope shared by all responses; the business code is checked at this layer (HTTP 200 + retCode != 0 is also a failure).
const envelope = {
  retCode: maybe(Schema.Number), // a number, 0 = OK
  retMsg: maybe(Schema.String),
};

export const BybitEnvelope = Schema.Struct(envelope);
export type BybitEnvelope = typeof BybitEnvelope.Type;

// Unified account (UTA) /v5/account/wallet-balance
export const BybitCoin = Schema.Struct({
  coin: maybe(Schema.String),
  walletBalance: maybe(Schema.String), // cash balance (excluding contract uPnL): the holdings basis
  equity: maybe(Schema.String), // = walletBalance + unrealisedPnl: not the holdings basis
  usdValue: maybe(Schema.String), // Bybit's own USD value: the valuation basis, no extra request
  locked: maybe(Schema.String), // amount locked by orders / products (included in walletBalance)
});
export type BybitCoin = typeof BybitCoin.Type;

export const BybitWalletBalanceResponse = Schema.Struct({
  ...envelope,
  result: maybe(
    Schema.Struct({
      list: maybe(
        Schema.Array(
          Schema.Struct({
            accountType: maybe(Schema.String),
            totalEquity: maybe(Schema.String),
            totalPerpUPL: maybe(Schema.String), // total contract unrealised PnL: non-zero means unrealised profit is excluded from walletBalance
            coin: maybe(Schema.Array(BybitCoin)),
          }),
        ),
      ),
    }),
  ),
});
export type BybitWalletBalanceResponse = typeof BybitWalletBalanceResponse.Type;

// Funding account /v5/asset/transfer/query-account-coins-balance
export const BybitFundingCoin = Schema.Struct({
  coin: maybe(Schema.String),
  walletBalance: maybe(Schema.String), // total balance: the holdings basis
});
export type BybitFundingCoin = typeof BybitFundingCoin.Type;

export const BybitFundingResponse = Schema.Struct({
  ...envelope,
  result: maybe(Schema.Struct({ balance: maybe(Schema.Array(BybitFundingCoin)) })),
});
export type BybitFundingResponse = typeof BybitFundingResponse.Type;

// Earn /v5/earn/position
// Bybit's earn position endpoint has no APR field (only amount / totalPnl / yesterdayYield).
export const BybitEarnPosition = Schema.Struct({
  coin: maybe(Schema.String),
  amount: maybe(Schema.String), // lent / staked principal: the holdings basis
});
export type BybitEarnPosition = typeof BybitEarnPosition.Type;

export const BybitEarnResponse = Schema.Struct({
  ...envelope,
  result: maybe(Schema.Struct({ list: maybe(Schema.Array(BybitEarnPosition)) })),
});
export type BybitEarnResponse = typeof BybitEarnResponse.Type;
