import type { ConnectorId } from "@folio/connectors";
import type { AccountSafe } from "@folio/db";
import { isManual } from "@/lib/core/manual";

// Manual accounts are not a sync source: their value is computed on read and never snapshotted.
export function isSyncableAccount(a: Pick<AccountSafe, "archivedAt" | "connectorId">): boolean {
  return a.archivedAt == null && !isManual(a.connectorId);
}

// Per-account staleness, shared by the accounts list row and the header sync panel.
export const STALE_SYNC_MS = 3 * 24 * 60 * 60 * 1000;

// SYNC_DUE_MS: entering the home page past this triggers a sync; sparse because syncs are costly.
// SYNC_WARN_MS: the pill turns yellow past this. 24h is the 24h-gain baseline plus 2h slack; tying
// it to the sync period instead would turn the pill yellow on any flaky exchange.
export const SYNC_DUE_MS = 60 * 60 * 1000;
export const SYNC_WARN_MS = 26 * 60 * 60 * 1000;

// Judged on the newest snapshot only: the question is whether the portfolio's data as a whole has
// aged. A future timestamp (clock skew) counts as fresh.
export type DataFreshness = "never" | "stale" | "syncDue" | "fresh";

export function dataFreshness(lastSyncedAt: number | null, now: number): DataFreshness {
  if (lastSyncedAt == null) return "never";
  const age = now - lastSyncedAt;
  if (age < 0) return "fresh"; // clock skew must not mark good data as expired
  if (age > SYNC_WARN_MS) return "stale";
  if (age > SYNC_DUE_MS) return "syncDue";
  return "fresh";
}

// "never" is excluded: the never-synced attention item already turns the pill yellow.
export const isDataStale = (lastSyncedAt: number | null, now: number): boolean =>
  dataFreshness(lastSyncedAt, now) === "stale";

// "never" counts as due, so a new user's first sync runs on arrival.
export const isSyncDue = (lastSyncedAt: number | null, now: number): boolean =>
  dataFreshness(lastSyncedAt, now) !== "fresh";

export type AccountSyncStatus = "needsCreds" | "never" | "stale" | "fresh";

// Order is priority: missing creds is the root cause of "never synced", so report only that.
export function accountSyncStatus(
  account: { needsCredentials: boolean; takenAt: number | null },
  nowMs: number,
): AccountSyncStatus {
  if (account.needsCredentials) return "needsCreds";
  if (account.takenAt == null) return "never";
  return nowMs - account.takenAt > STALE_SYNC_MS ? "stale" : "fresh";
}

export interface SyncAccountInput {
  id: string;
  label: string;
  connectorId: ConnectorId;
  archivedAt: number | null;
  complete: boolean;
  /** null = never synced. */
  takenAt: number | null;
}

// One list holds both "no data" and "stale data": without the latter, an account unsynced for a
// week looked fine while the home total was old.
type SyncAttentionKind = "missing-credentials" | "never-synced" | "stale";

export interface SyncAttentionSource {
  id: string;
  label: string;
  connectorId: ConnectorId;
  kind: SyncAttentionKind;
  /** Only used by `stale` (renders "synced X ago"). */
  takenAt: number | null;
}

export interface SyncStatusSummary {
  /** Syncable active accounts; manual accounts have no upstream to ask. */
  accounts: { id: string; label: string }[];
  /**
   * Active accounts including manual ones (matches "across N sources"). Manual accounts are always
   * current, so the panel counts them as synced.
   */
  total: number;
  /** By severity, then oldest first. */
  attention: SyncAttentionSource[];
  /** null = none ever synced. */
  lastSyncedAt: number | null;
  /**
   * Portfolio-level: the newest snapshot is older than 26h. Separate from `attention`, which is
   * per account: 42h without sync but every account < 3 days leaves attention empty.
   */
  dataStale: boolean;
}

// Within a level, oldest takenAt first; a missing takenAt counts as oldest.
const SEVERITY: Record<SyncAttentionKind, number> = {
  "missing-credentials": 0,
  "never-synced": 1,
  stale: 2,
};

const KIND_OF: Record<AccountSyncStatus, SyncAttentionKind | null> = {
  needsCreds: "missing-credentials",
  never: "never-synced",
  stale: "stale",
  fresh: null,
};

// `now` is a parameter so tests can hit exact thresholds without the wall clock.
export function summarizeSync(accounts: SyncAccountInput[], now: number): SyncStatusSummary {
  const active = accounts.filter((a) => a.archivedAt == null);
  // Manual accounts count as sources but are never synced or listed for attention.
  const syncable = active.filter((a) => !isManual(a.connectorId));
  const attention = syncable
    .flatMap((a) => {
      const kind =
        KIND_OF[accountSyncStatus({ needsCredentials: !a.complete, takenAt: a.takenAt }, now)];
      return kind
        ? [{ id: a.id, label: a.label, connectorId: a.connectorId, kind, takenAt: a.takenAt }]
        : [];
    })
    .sort((x, y) => SEVERITY[x.kind] - SEVERITY[y.kind] || (x.takenAt ?? 0) - (y.takenAt ?? 0));
  const lastSyncedAt = syncable.reduce<number | null>(
    (max, a) => (a.takenAt == null ? max : max == null ? a.takenAt : Math.max(max, a.takenAt)),
    null,
  );
  return {
    accounts: syncable.map((a) => ({ id: a.id, label: a.label })),
    total: active.length,
    attention,
    lastSyncedAt,
    dataStale: isDataStale(lastSyncedAt, now),
  };
}
