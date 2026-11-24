import { z } from "zod";
import { Note } from "./note";

// Invariant: an account's totalUsd === Σ value, where value is the row's signed net contribution
// (liabilities negative). Each economic position carries value on exactly one row; rows that would
// double-count carry 0 (perp equity row valued, position rows 0; LP pool valued, underlying 0).
export const BalanceBase = z.object({
  symbol: z.string(),
  amount: z.number(),
  value: z.number(), // USD
  price: z.number().optional(), // USD per unit
  // The provider's own unit price, never overwritten by revaluation (unlike `price`), so a
  // valuation can be recomputed from it under a different source or mode.
  selfPrice: z.number().optional(),
  // `<chain>/<address>`, `<chain>/native`, `<venue>/<code>`, `coingecko/<id>` or `manual/<symbol>`.
  // Rows that can't produce one are dropped by the producer.
  tokenRef: z.string(),
  name: z.string().optional(),
  logo: z.string().optional(),
  // Display only: e.g. a CEX coin's locked/frozen portion.
  note: Note.optional(),
});

export const DefiMeta = z.object({
  protocol: z.string().optional(),
  positionType: z.string().optional(),
  // Upstream logo URL; resolved server-side by the defi logo proxy. Absent on old snapshots.
  protocolLogo: z.string().optional(),
});

export const PerpEquityMeta = z.object({
  withdrawable: z.number(),
  totalMarginUsed: z.number(),
  totalNtlPos: z.number(),
});

// value is 0; the notional exposure lives in meta.
export const PerpPositionMeta = z.object({
  coin: z.string(),
  side: z.enum(["long", "short"]),
  entryPx: z.number(),
  positionValue: z.number(), // notional USD, not a net-worth contribution
  unrealizedPnl: z.number(),
  leverage: z.number().optional(),
  leverageType: z.string().optional(),
  liquidationPx: z.number().nullable(),
  marginUsed: z.number(),
});

export const Spot = BalanceBase.extend({ kind: z.literal("spot") });
export const Defi = BalanceBase.extend({ kind: z.literal("defi"), meta: DefiMeta });
export const PerpEquity = BalanceBase.extend({
  kind: z.literal("perp_equity"),
  meta: PerpEquityMeta,
});
export const PerpPosition = BalanceBase.extend({
  kind: z.literal("perp_position"),
  meta: PerpPositionMeta,
});

export const Balance = z.discriminatedUnion("kind", [Spot, Defi, PerpEquity, PerpPosition]);

export type Balance = z.infer<typeof Balance>;
export type BalanceKind = Balance["kind"];
export type Spot = z.infer<typeof Spot>;
export type Defi = z.infer<typeof Defi>;
export type PerpEquity = z.infer<typeof PerpEquity>;
export type PerpPosition = z.infer<typeof PerpPosition>;
export type DefiMeta = z.infer<typeof DefiMeta>;
export type PerpEquityMeta = z.infer<typeof PerpEquityMeta>;
export type PerpPositionMeta = z.infer<typeof PerpPositionMeta>;
