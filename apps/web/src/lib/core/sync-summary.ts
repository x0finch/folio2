import type { ConnectorId } from "@folio/connectors";
import type { AccountSnapshot } from "@/lib/server/portfolio/snapshots";
import { type SyncStatusSummary, summarizeSync } from "@/lib/server/sync/status";

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
  snapshots: readonly AccountSnapshot[],
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
