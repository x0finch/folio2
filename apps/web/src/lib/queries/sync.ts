import type { QueryClient } from "@tanstack/react-query";
import { useSuspenseQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { floorToHour } from "@/lib/core/portfolio";
import type { SyncStatusSummary } from "@/lib/core/sync-status";
import { deriveSyncStatus } from "@/lib/core/sync-summary";
import { accountListQuery } from "./accounts";
import { accountHoldingsSnapshotQueries } from "./snapshots";

// 页头同步摘要(FOL-58):accounts + snapshots 在浏览器派生,不再走独立 server fn。

export type { SyncStatusSummary } from "@/lib/core/sync-status";

/** 外壳 loader 预取摘要原料 —— 与 `useSyncStatus` 读同一份原子 query。 */
export async function prefetchSyncStatusAtoms(
  queryClient: QueryClient,
  portfolioId: string,
): Promise<void> {
  const now = floorToHour(Date.now());
  const { now: snapshotsNow } = accountHoldingsSnapshotQueries(portfolioId, now);
  await Promise.all([
    queryClient.ensureQueryData(accountListQuery(portfolioId)),
    queryClient.ensureQueryData(snapshotsNow),
  ]);
}

/** 页头同步胶囊:accounts + 当下快照 → `summarizeSync`(FOL-58)。 */
export function useSyncStatus(portfolioId: string): SyncStatusSummary {
  const now = floorToHour(Date.now());
  const { now: snapshotsNow } = accountHoldingsSnapshotQueries(portfolioId, now);
  const [{ data: accounts }, { data: snapshots }] = useSuspenseQueries({
    queries: [accountListQuery(portfolioId), snapshotsNow],
  });
  return useMemo(() => deriveSyncStatus(accounts, snapshots, now), [accounts, snapshots, now]);
}
