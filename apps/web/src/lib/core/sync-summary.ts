import type { ConnectorId } from "@folio/connectors";
import { type SyncStatusSummary, summarizeSync } from "@/lib/core/sync-status";

/** Same shape as the server's `AccountSnapshot`; core must not import server. */
export interface SyncSnapshotSlice {
  accountId: string;
  takenAt: number;
}

type SyncAccountRow = {
  id: string;
  label: string;
  connectorId: ConnectorId;
  archivedAt: number | null;
  needsCredentials: boolean;
};

export function deriveSyncStatus(
  accounts: readonly SyncAccountRow[],
  snapshots: readonly SyncSnapshotSlice[],
  now: number,
): SyncStatusSummary {
  const takenAtById = new Map(snapshots.map((s) => [s.accountId, s.takenAt]));
  return summarizeSync(
    accounts.map((a) => ({
      id: a.id,
      label: a.label,
      connectorId: a.connectorId,
      archivedAt: a.archivedAt,
      complete: !a.needsCredentials,
      takenAt: takenAtById.get(a.id) ?? null,
    })),
    now,
  );
}
