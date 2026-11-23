import type { QueryClient } from "@tanstack/react-query";
import { useSuspenseQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { floorToHour } from "@/lib/core/portfolio";
import type { SyncStatusSummary } from "@/lib/core/sync-status";
import { deriveSyncStatus } from "@/lib/core/sync-summary";
import { accountListQuery } from "./accounts";
import { accountHoldingsSnapshotQueries } from "./snapshots";

// Header sync summary: derived in the browser from accounts + snapshots.

export type { SyncStatusSummary } from "@/lib/core/sync-status";

/** Shell loader prefetch; reads the same atom queries as `useSyncStatus`. */
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

/** Header sync pill: accounts + current snapshot into `summarizeSync`. */
export function useSyncStatus(portfolioId: string): SyncStatusSummary {
  const now = floorToHour(Date.now());
  const { now: snapshotsNow } = accountHoldingsSnapshotQueries(portfolioId, now);
  const [{ data: accounts }, { data: snapshots }] = useSuspenseQueries({
    queries: [accountListQuery(portfolioId), snapshotsNow],
  });
  return useMemo(() => deriveSyncStatus(accounts, snapshots, now), [accounts, snapshots, now]);
}
