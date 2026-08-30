import { queryOptions } from "@tanstack/react-query";
import { floorToHour, GAIN_START_FLOOR_MS, GAIN_WINDOW_MS } from "@/lib/core/portfolio";
import { getSnapshots } from "@/lib/server/portfolio";
import { STALE_TIME } from "./constants";
import { portfolioKeys } from "./keys";

// 组合快照原子读(FOL-54):`at`/`after` 由调用方 hour-floor 后传入,保证 queryKey 稳定。

export const portfolioSnapshotsQuery = (
  portfolioId: string,
  at: number,
  after?: number,
  now?: number,
) =>
  queryOptions({
    queryKey: portfolioKeys.snapshots(portfolioId, at, after),
    // `at` 进 key(hour-floor);当下快照的 SQL 上界用真实 `now`,避免整点内新同步被截掉。
    queryFn: () =>
      getSnapshots({
        data: { portfolioId, at, after, now: after == null ? Date.now() : now },
      }),
    staleTime: STALE_TIME.live,
  });

/** 账户页持仓用的 hour 锚 + 24h 前/7d 下界 —— 与 `assembleAccountHoldingsData` 同口径。 */
export const accountHoldingsSnapshotTimes = (now = floorToHour(Date.now())) => ({
  now,
  prevAt: now - GAIN_WINDOW_MS,
  prevAfter: now - GAIN_START_FLOOR_MS,
});

export const accountHoldingsSnapshotQueries = (
  portfolioId: string,
  now = floorToHour(Date.now()),
) => {
  const { prevAt, prevAfter } = accountHoldingsSnapshotTimes(now);
  return {
    now: portfolioSnapshotsQuery(portfolioId, now, undefined, now),
    prev: portfolioSnapshotsQuery(portfolioId, prevAt, prevAfter, now),
  };
};
