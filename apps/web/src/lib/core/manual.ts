import type { ConnectorId } from "@folio/connectors";
import type { ManualActivityKind } from "@folio/db";
import type { SnapshotTotalRow } from "./history";

// Components import this file, so keep it to identity checks: anything else here would ride into
// the client bundle.
export const MANUAL_CONNECTOR_ID = "manual" satisfies ConnectorId;

export function isManual(connectorId: ConnectorId): boolean {
  return connectorId === MANUAL_CONNECTOR_ID;
}

// Fold order: occurredAt, then createdAt. `set` resets the baseline. Each step clamps at 0: deleting
// an earlier `set` can retroactively oversell, and per-step clamping gives the intuitive result
// (hold 1, sell 2 → 0, buy 1 → 1) rather than clamping only the final sum.
export interface DerivableActivity {
  kind: ManualActivityKind;
  amount: number;
  occurredAt: number;
  createdAt: number;
}

// Relative to the step's magnitude (min 1): far above float error (0.1 + 0.2 − 0.3 = 5.55e-17)
// yet far below any meaningful amount (1 sat = 1e-8 BTC).
const AMOUNT_REL_TOLERANCE = 1e-12;
const tolerance = (scale: number) => AMOUNT_REL_TOLERANCE * Math.max(1, Math.abs(scale));

/**
 * One fold step. Read and write paths all share it so they agree on the tolerance (otherwise a full
 * sell leaves a 5.55e-17 ghost holding, or a sale the write path accepted shows as oversold).
 * A remainder within tolerance becomes exactly 0; beyond it is oversold and clamps to 0.
 */
export function foldStep(
  held: number,
  activity: Pick<DerivableActivity, "kind" | "amount">,
): { held: number; oversold: boolean } {
  if (activity.kind === "set") return { held: activity.amount, oversold: false };
  if (activity.kind === "add") return { held: held + activity.amount, oversold: false };
  const tol = tolerance(Math.max(held, activity.amount));
  const next = held - activity.amount;
  if (next > tol) return { held: next, oversold: false };
  return { held: 0, oversold: next < -tol };
}

export const inFoldOrder = <T extends DerivableActivity>(activities: readonly T[]): T[] =>
  [...activities].sort((a, b) => a.occurredAt - b.occurredAt || a.createdAt - b.createdAt);

export function deriveAmount(activities: DerivableActivity[]): number {
  let amount = 0;
  for (const a of inFoldOrder(activities)) amount = foldStep(amount, a).held;
  return amount;
}

// `id` must reach the synthesized balance: enrichment, warm-up and price refresh all key on
// tokenId, so without it the token gets no name, logo or price. `ref` is passed through untouched.
export interface ManualTokenDef {
  id: string;
  symbol: string;
  ref?: string | null;
}
export interface CredsToken {
  id: string;
  symbol: string;
  amount: number;
  // Already resolved through the price fallback chain; null = no source at all.
  fallbackPrice: number | null;
  ref: string | null;
}

/**
 * The latest priced activity in the ledger. The ledger is the only source of a unit price (a second
 * stored price once drifted and couldn't be corrected). Matches tier ② of `tokenPriceAt`.
 */
export function fallbackUnitPrice(
  activities: readonly (DerivableActivity & { price?: number | null })[],
): number | null {
  // Ties on occurredAt break by createdAt, same as the fold.
  let best: (DerivableActivity & { price?: number | null }) | undefined;
  for (const a of activities) {
    if (a.price == null) continue;
    if (
      !best ||
      a.occurredAt > best.occurredAt ||
      (a.occurredAt === best.occurredAt && a.createdAt > best.createdAt)
    ) {
      best = a;
    }
  }
  return best?.price ?? null;
}

export function projectToken(
  token: ManualTokenDef,
  activities: readonly (DerivableActivity & { price?: number | null })[],
): CredsToken {
  return {
    id: token.id,
    symbol: token.symbol,
    amount: deriveAmount([...activities]),
    fallbackPrice: fallbackUnitPrice(activities),
    ref: token.ref ?? null,
  };
}

// value@T = quantity@T × price@T, computed on read, so editing a past activity never leaves stale
// points. Sampled on a daily grid rather than at trade times so the curve follows the market between
// trades.

// Same bucketing as @folio/oracle-basic's dayBucketOf, so grid points land in the injected
// priceAt's day buckets. Kept local to avoid importing the oracle package.
const MS_PER_DAY = 86_400_000;

// price feeds fallback tier ②, not the quantity fold.
export interface HistoryActivity {
  kind: ManualActivityKind;
  amount: number;
  occurredAt: number;
  createdAt: number;
  price?: number | null;
}
export interface HistoryToken {
  id: string; // tokens.id; historical prices are keyed by it
  unitPrice: number;
  // false = upstream doesn't know it → skip tier ①.
  recognized?: boolean;
  // Set for whitelisted fiat cash: the server prices it by FX rate instead of a token price.
  // Fiat is always recognized.
  fiatCode?: string;
  activities: HistoryActivity[];
}

// Injected by the server from one prefetched price series; undefined falls through the chain.
export type HistoricalPriceAt = (tokenId: string, t: number) => number | undefined;

// ① historical oracle price if recognized → ② latest priced activity at or before T → ③ current
// unitPrice (flat line).
export function tokenPriceAt(token: HistoryToken, t: number, priceAt?: HistoricalPriceAt): number {
  if (token.recognized && priceAt) {
    const p = priceAt(token.id, t); // ①
    if (p != null) return p;
  }
  let best: HistoryActivity | undefined; // ②
  for (const a of token.activities) {
    if (a.occurredAt > t || a.price == null) continue;
    if (
      !best ||
      a.occurredAt > best.occurredAt ||
      (a.occurredAt === best.occurredAt && a.createdAt > best.createdAt)
    ) {
      best = a;
    }
  }
  return best?.price ?? token.unitPrice; // ② else ③
}

export function tokenQuantityAt(token: HistoryToken, t: number): number {
  return deriveAmount(token.activities.filter((a) => a.occurredAt <= t));
}

export function accountTotalAt(
  tokens: HistoryToken[],
  t: number,
  priceAt?: HistoricalPriceAt,
): number {
  let total = 0;
  for (const tk of tokens) total += tokenQuantityAt(tk, t) * tokenPriceAt(tk, t, priceAt);
  return total;
}

// Flags it in the activity list only; the fold result is unchanged.
export function isReduceOversold(
  activities: HistoryActivity[],
  activity: Pick<HistoryActivity, "kind" | "amount" | "occurredAt" | "createdAt">,
): boolean {
  if (activity.kind !== "reduce") return false;
  const before = activities.filter(
    (a) =>
      a.occurredAt < activity.occurredAt ||
      (a.occurredAt === activity.occurredAt && a.createdAt < activity.createdAt),
  );
  return foldStep(deriveAmount(before), activity).oversold;
}

// Sample times: first activity (so a same-day account has a start point), every UTC day end after
// it, and now. Any account with activity gets ≥ 2 points, which the drawer chart needs. The grid
// covers all history; callers trim to their window.
export function buildManualAccountSeries(
  accountId: string,
  tokens: HistoryToken[],
  now: number,
  priceAt?: HistoricalPriceAt,
): SnapshotTotalRow[] {
  let firstOccurred = Number.POSITIVE_INFINITY;
  for (const tk of tokens)
    for (const a of tk.activities) firstOccurred = Math.min(firstOccurred, a.occurredAt);
  if (!Number.isFinite(firstOccurred) || firstOccurred > now) return []; // none, or all in future

  const times = new Set<number>([firstOccurred, now]);
  const firstBucket = Math.floor(firstOccurred / MS_PER_DAY);
  const nowBucket = Math.floor(now / MS_PER_DAY);
  for (let b = firstBucket; b <= nowBucket; b++) {
    // 1ms before the next day, so floor(t / MS_PER_DAY) === b matches priceAt's buckets.
    const t = Math.min((b + 1) * MS_PER_DAY - 1, now);
    if (t > firstOccurred) times.add(t);
  }

  return [...times]
    .sort((a, b) => a - b)
    .map((t) => ({ accountId, takenAt: t, totalUsd: accountTotalAt(tokens, t, priceAt) }));
}
