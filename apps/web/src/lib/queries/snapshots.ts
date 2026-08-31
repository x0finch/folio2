import { queryOptions } from "@tanstack/react-query";
import { floorToHour, GAIN_START_FLOOR_MS, GAIN_WINDOW_MS } from "@/lib/core/portfolio";
import { getSnapshots } from "@/lib/server/portfolio";
import { STALE_TIME } from "./constants";
import { portfolioKeys } from "./keys";

// 组合快照原子读(FOL-54):queryKey 用 hour-floor 锚;请求体的 `at` 是真实查库上界(当下 = 墙钟)。

const portfolioSnapshotsQuery = (
  portfolioId: string,
  keyAt: number,
  at: number,
  after?: number,
) =>
  queryOptions({
    queryKey: portfolioKeys.snapshots(portfolioId, keyAt, after),
    queryFn: () => getSnapshots({ data: { portfolioId, at, after } }),
    staleTime: STALE_TIME.live,
  });

/** 账户页持仓用的 hour 锚 + 24h 前/7d 下界 —— 与 `assembleAccountHoldingsData` 同口径。 */
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
