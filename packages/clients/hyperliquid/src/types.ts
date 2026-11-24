import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// Minimal shape of the `clearinghouseState` response (only the fields used). Types derive from the schema.
// Number fields are all `string`: hyperliquid sends numbers as strings; conversion belongs to the adapter.

export const HlLeverage = Schema.Struct({
  value: maybe(Schema.Number),
  type: maybe(Schema.String),
  rawUsd: maybe(Schema.String),
});
export type HlLeverage = typeof HlLeverage.Type;

export const HlPosition = Schema.Struct({
  coin: maybe(Schema.String),
  szi: maybe(Schema.String), // signed: positive = long, negative = short
  entryPx: maybe(Schema.String),
  positionValue: maybe(Schema.String), // notional USD (leveraged exposure, not a net-worth contribution)
  unrealizedPnl: maybe(Schema.String),
  leverage: maybe(HlLeverage),
  // The `null` stays in the type: no liquidation price differs from the field not being given, and the adapter tells them apart.
  liquidationPx: Schema.optional(Schema.NullOr(Schema.String)),
  marginUsed: maybe(Schema.String),
});
export type HlPosition = typeof HlPosition.Type;

export const HlMarginSummary = Schema.Struct({
  accountValue: maybe(Schema.String), // total account equity (margin + unrealised PnL) = the real contribution to net worth
  totalMarginUsed: maybe(Schema.String),
  totalNtlPos: maybe(Schema.String),
  totalRawUsd: maybe(Schema.String),
});
export type HlMarginSummary = typeof HlMarginSummary.Type;

export const ClearinghouseState = Schema.Struct({
  marginSummary: maybe(HlMarginSummary),
  assetPositions: maybe(Schema.Array(Schema.Struct({ position: maybe(HlPosition) }))),
  withdrawable: maybe(Schema.String),
});
export type ClearinghouseState = typeof ClearinghouseState.Type;
