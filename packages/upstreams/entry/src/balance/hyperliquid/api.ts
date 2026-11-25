import { Schema } from "effect";
import type { Call } from "../../runtime/define";
import { maybe } from "../../runtime/schema";
import { CLEARINGHOUSE_TYPE, INFO_PATH } from "./constants";

// Only the fields we read. Hyperliquid sends every number as a string.
const HlLeverage = Schema.Struct({
  value: maybe(Schema.Number),
  type: maybe(Schema.String),
  rawUsd: maybe(Schema.String),
});

const HlPosition = Schema.Struct({
  coin: maybe(Schema.String),
  szi: maybe(Schema.String), // signed: positive = long, negative = short
  entryPx: maybe(Schema.String),
  positionValue: maybe(Schema.String), // leveraged notional, not a net-worth contribution
  unrealizedPnl: maybe(Schema.String),
  leverage: maybe(HlLeverage),
  // `null` stays: no liquidation price differs from the field not being given.
  liquidationPx: Schema.optional(Schema.NullOr(Schema.String)),
  marginUsed: maybe(Schema.String),
});

const HlMarginSummary = Schema.Struct({
  accountValue: maybe(Schema.String), // equity incl. unrealised PnL: the real net-worth contribution
  totalMarginUsed: maybe(Schema.String),
  totalNtlPos: maybe(Schema.String),
  totalRawUsd: maybe(Schema.String),
});

export const ClearinghouseState = Schema.Struct({
  marginSummary: maybe(HlMarginSummary),
  assetPositions: maybe(Schema.Array(Schema.Struct({ position: maybe(HlPosition) }))),
  withdrawable: maybe(Schema.String),
});
export type ClearinghouseState = typeof ClearinghouseState.Type;

// Perp margin summary and positions of one address.
export const clearinghouseState = (call: Call, user: string) =>
  call.request(INFO_PATH, ClearinghouseState, {
    method: "POST",
    body: JSON.stringify({ type: CLEARINGHOUSE_TYPE, user }),
  });
