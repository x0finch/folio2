import {
  type BalanceRawRow,
  Database,
  type SnapshotRawRow,
  type SnapshotWithBalances,
} from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { GAIN_WINDOW_MS } from "@/lib/core/portfolio";
import type { SnapshotsWire } from "@/lib/core/snapshot-wire";
import { injectManualPrevSnapshots, injectManualSnapshots } from "@/lib/server/manual/store";
import { scopedMembership } from "./scope";

// Per-account snapshots for a portfolio at a point in time. Raw D1 rows only (no enrich, no parsing):
// the browser parses (`@/lib/core/snapshot-wire`) and merges live prices. Manual accounts are synthesized at `at`.
export const SnapshotsInput = z.object({
  portfolioId: z.string().optional(),
  at: z.number(),
  after: z.number().optional(),
});

const manualToWire = (byAccount: ReadonlyMap<string, SnapshotWithBalances>): SnapshotsWire => {
  const snapshots: SnapshotRawRow[] = [];
  const balances: BalanceRawRow[] = [];
  for (const [accountId, s] of byAccount) {
    snapshots.push([accountId, s.snapshot.takenAt, s.snapshot.totalUsd, s.snapshot.note]);
    for (const b of s.balances) {
      balances.push([
        accountId,
        b.id,
        b.amount,
        b.usdValue,
        b.kind,
        b.selfPrice ?? null,
        b.platform ?? null,
        b.tokenId ?? null,
        b.metaJson ?? null,
      ]);
    }
  }
  return { snapshots, balances };
};

export const handleGetSnapshots = Effect.fn("getSnapshots")(function* (
  data: z.infer<typeof SnapshotsInput>,
) {
  const db = yield* Database;
  // A live read (no `after`) has no upper bound: a snapshot whose `takenAt` slightly exceeds the reader's
  // clock must not be cut by `at`, and collapseSameHour leaves no fallback row. Historical reads use [after, at].
  const [scope, raw] = yield* Effect.all(
    [
      scopedMembership(data.portfolioId),
      data.after != null ? db.snapshots.asOfRaw(data.at, data.after) : db.snapshots.latestRaw(),
    ],
    { concurrency: 2 },
  );
  const active = scope.accounts.filter((a) => scope.has(a.id) && a.archivedAt == null);

  const manual = new Map<string, SnapshotWithBalances>();
  if (data.after != null) {
    // prev's `at` is always the live anchor minus 24h; derive the hour anchor to align manual start prices.
    yield* injectManualPrevSnapshots(active, manual, data.at, data.at + GAIN_WINDOW_MS);
  } else {
    // Active manual only: archived accounts' frozen values come from real snapshots.
    yield* injectManualSnapshots(active, manual, data.at);
  }
  // A synthesized snapshot wins over the stored one.
  const keep = (accountId: string) => scope.has(accountId) && !manual.has(accountId);
  const synced: SnapshotsWire = {
    snapshots: raw.snapshots.filter((r) => keep(r[0])),
    balances: raw.balances.filter((r) => keep(r[0])),
  };
  if (manual.size === 0) return synced;
  const injected = manualToWire(manual);
  return {
    snapshots: [...synced.snapshots, ...injected.snapshots],
    balances: [...synced.balances, ...injected.balances],
  } satisfies SnapshotsWire;
});
