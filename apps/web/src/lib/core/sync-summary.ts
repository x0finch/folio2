import type { ConnectorId } from "@folio/connectors";
import { type SyncStatusSummary, summarizeSync } from "@/lib/core/sync-status";

/** 快照原料切片 —— 与 server 层 `AccountSnapshot` 同形,core 不 import server。 */
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

/** 从原子账户行与当下快照拼出页头同步摘要(FOL-58)。 */
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
