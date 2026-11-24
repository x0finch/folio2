import type { SyncRoundAccountStatus, SyncRoundRecord, SyncRoundTrigger } from "@folio/db";

export {
  accountSyncStatus,
  isSyncableAccount,
  STALE_SYNC_MS,
  type SyncAccountInput,
  type SyncStatusSummary,
  summarizeSync,
} from "@/lib/core/sync-status";

// Interrupted isn't a failure: nobody is running it any more and there is no result.
type SyncRoundState = "running" | "interrupted" | "done";

export interface SyncRoundFailure {
  accountId: string;
  /** Display name frozen when the round started. */
  label: string;
  error: string;
}

/** Polled while a round runs. */
export interface SyncRoundView {
  roundId: string;
  state: SyncRoundState;
  trigger: SyncRoundTrigger;
  startedAt: number;
  finishedAt: number | null;
  /** The N in `x / N`. Once done, excludes `unresolved` accounts that will never report. */
  total: number;
  settled: number;
  /** Real successes only; the panel adds manual sources itself. */
  synced: number;
  failed: SyncRoundFailure[];
  /** Missing creds; neither success nor failure. */
  needsKeys: number;
  /** Deliberately skipped in an auto round because data was still fresh. */
  skipped: number;
  current: string | null;
  /** Still pending at finish (archived or deleted mid-round); logged, not shown. */
  unresolved: number;
  /** Round-level failure (listing accounts / creds). Per-account failures are in `failed`. */
  error: string | null;
  /** Per-account outcome, so a single-account sync can spot its own result in a shared round. */
  statuses: Record<string, SyncRoundAccountStatus>;
}

// An empty error column would read as a broken UI.
const UNKNOWN_FAILURE = "sync failed";

/**
 * Live = not finished and not expired. `now >= expiresAt` must match the round-opening condition,
 * or a new round could open while the panel still shows the old one running.
 */
export function syncRoundView(round: SyncRoundRecord, now: number): SyncRoundView {
  const entries = Object.entries(round.accounts);
  const tally: Record<SyncRoundAccountStatus, number> = {
    pending: 0,
    synced: 0,
    failed: 0,
    "needs-keys": 0,
    skipped: 0,
  };
  const failed: SyncRoundFailure[] = [];
  const statuses: Record<string, SyncRoundAccountStatus> = {};
  let current: string | null = null;
  for (const [accountId, a] of entries) {
    tally[a.status] += 1;
    statuses[accountId] = a.status;
    if (a.status === "pending") current ??= a.label;
    if (a.status === "failed") {
      failed.push({ accountId, label: a.label, error: a.error || UNKNOWN_FAILURE });
    }
  }
  const state: SyncRoundState =
    round.finishedAt != null ? "done" : now >= round.expiresAt ? "interrupted" : "running";
  // Pending after finish means the account vanished mid-round; keeping it in the denominator would
  // read as a missed sync forever. Running or interrupted rounds keep the full list.
  const unresolved = state === "done" ? tally.pending : 0;
  return {
    roundId: round.roundId,
    state,
    trigger: round.trigger,
    startedAt: round.startedAt,
    finishedAt: round.finishedAt,
    total: entries.length - unresolved,
    settled: entries.length - tally.pending,
    synced: tally.synced,
    unresolved,
    failed,
    needsKeys: tally["needs-keys"],
    skipped: tally.skipped,
    current,
    error: round.error ?? null,
    statuses,
  };
}
