import type { ManualActivityKind } from "@folio/db";
import { type DerivableActivity, foldStep, inFoldOrder } from "@/lib/core/manual";

// Pure planning for batched manual writes: drafts → tokens to declare + activities to insert, or
// the whole batch rejected with the oversold symbol.

// Oversell guard. Uses the same `foldStep` as the read path, so a ledger accepted on write is never
// flagged as oversold on read.
export function runningOk(activities: DerivableActivity[]): boolean {
  let held = 0;
  for (const a of inFoldOrder(activities)) {
    const step = foldStep(held, a);
    if (step.oversold) return false;
    held = step.held;
  }
  return true;
}

export interface Token {
  id: string;
  symbol: string;
  activities: DerivableActivity[];
}

// `ticket` is the picker's opaque token; carried through, never interpreted here.
interface PickedTokenInput {
  symbol: string;
  unitPrice: number;
  ticket?: string | null;
}

// `tokenId` is minted by the caller before planning, so token identity isn't guessed here.
export type ResolvedTokenInput = PickedTokenInput & { tokenId: string };

// `createdAt` is assigned server-side in submission order.
export interface BatchDraft {
  token: PickedTokenInput;
  kind: ManualActivityKind;
  amount: number;
  occurredAt: number;
  price?: number | null;
  fee?: number | null;
  memo?: string | null;
}

export type ResolvedDraft = Omit<BatchDraft, "token"> & { token: ResolvedTokenInput };

interface PlannedToken {
  id: string;
  symbol: string;
}
interface PlannedActivity {
  tokenId: string;
  kind: ManualActivityKind;
  amount: number;
  price?: number | null;
  fee?: number | null;
  occurredAt: number;
  memo?: string | null;
}
export type BatchPlan =
  | { ok: false; symbol: string }
  | { ok: true; declare: PlannedToken[]; activities: PlannedActivity[] };

// Identity was settled by mint; same-symbol different tokens can't be confused here.
export function findToken(tokens: Token[], ref: ResolvedTokenInput): Token | undefined {
  return tokens.find((t) => t.id === ref.tokenId);
}

export function planManualBatch(existing: Token[], drafts: ResolvedDraft[]): BatchPlan {
  const working: Token[] = existing.map((t) => ({ ...t, activities: [...t.activities] }));
  const declare: PlannedToken[] = [];
  const activities: PlannedActivity[] = [];
  // Draft createdAt values sort after any real epoch-ms createdAt at the same occurredAt, in
  // submission order, matching the insert order (createdAt = now + i).
  const draftSeqBase = Number.MAX_SAFE_INTEGER - drafts.length;

  drafts.forEach((d, i) => {
    let token = findToken(working, d.token);
    if (!token) {
      // New holding; the id comes from mint, so two drafts for one token share a holding.
      // Never derive self_price from the trade price: a stored 0 would stick forever. The display
      // computes the fallback price each time; we store only what the user declared.
      token = { id: d.token.tokenId, symbol: d.token.symbol, activities: [] };
      working.push(token);
      declare.push({ id: token.id, symbol: token.symbol });
    }
    activities.push({
      tokenId: token.id,
      kind: d.kind,
      amount: d.amount,
      price: d.price ?? null,
      fee: d.fee ?? null,
      occurredAt: d.occurredAt,
      memo: d.memo ?? null,
    });
    token.activities.push({
      kind: d.kind,
      amount: d.amount,
      occurredAt: d.occurredAt,
      createdAt: draftSeqBase + i,
    });
  });

  for (const t of working) {
    if (!runningOk(t.activities)) return { ok: false, symbol: t.symbol };
  }
  return { ok: true, declare, activities };
}
