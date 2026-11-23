import { queryOptions } from "@tanstack/react-query";
import { readJson } from "@/lib/core/json-response";
import { floorToHour, GAIN_START_FLOOR_MS, GAIN_WINDOW_MS } from "@/lib/core/portfolio";
import { snapshotsFromWire } from "@/lib/core/snapshot-wire";
import { getSnapshots } from "@/lib/server/portfolio";
import { RETRY, STALE_TIME, shouldRetry } from "./constants";
import { portfolioKeys } from "./keys";

// Portfolio snapshot atoms: the queryKey uses the hour-floored anchor; the request's `at` is the real upper bound (now = wall clock).

const portfolioSnapshotsQuery = (portfolioId: string, keyAt: number, at: number, after?: number) =>
  queryOptions({
    queryKey: portfolioKeys.snapshots(portfolioId, keyAt, after),
    queryFn: async () =>
      snapshotsFromWire(await readJson(await getSnapshots({ data: { portfolioId, at, after } }))),
    staleTime: STALE_TIME.live,
    // `useSyncStatus` suspends on the current snapshot in the shell (no island boundary); the default 5 failures would throw
    // the whole authed shell into `StalledShell` where `reset` can't recover, so retry forever like `accountListQuery`.
    retry: (failureCount, error) => shouldRetry(failureCount, error, RETRY.forever),
  });

/** Hour anchor + 24h-ago / 7d lower bound for account holdings; same basis as `assembleAccountHoldingsData`. */
export const accountHoldingsSnapshotTimes = (anchor = floorToHour(Date.now())) => ({
  anchor,
  prevAt: anchor - GAIN_WINDOW_MS,
  prevAfter: anchor - GAIN_START_FLOOR_MS,
});

export const accountHoldingsSnapshotQueries = (
  portfolioId: string,
  anchor = floorToHour(Date.now()),
) => {
  const { prevAt, prevAfter } = accountHoldingsSnapshotTimes(anchor);
  return {
    now: portfolioSnapshotsQuery(portfolioId, anchor, Date.now()),
    prev: portfolioSnapshotsQuery(portfolioId, prevAt, prevAt, prevAfter),
  };
};
