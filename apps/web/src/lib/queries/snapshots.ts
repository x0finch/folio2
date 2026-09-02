import { queryOptions } from "@tanstack/react-query";
import { floorToHour, GAIN_START_FLOOR_MS, GAIN_WINDOW_MS } from "@/lib/core/portfolio";
import { getSnapshots } from "@/lib/server/portfolio";
import { RETRY, STALE_TIME, shouldRetry } from "./constants";
import { portfolioKeys } from "./keys";

// 组合快照原子读(FOL-54):queryKey 用 hour-floor 锚;请求体的 `at` 是真实查库上界(当下 = 墙钟)。

const portfolioSnapshotsQuery = (portfolioId: string, keyAt: number, at: number, after?: number) =>
  queryOptions({
    queryKey: portfolioKeys.snapshots(portfolioId, keyAt, after),
    queryFn: () => getSnapshots({ data: { portfolioId, at, after } }),
    staleTime: STALE_TIME.live,
    // 页头同步胶囊 `useSyncStatus` 在外壳(无 island 边界)suspend 在当下快照上;默认 5 次失败即抛,
    // 整个 authed 壳掀进 `StalledShell` 且 `reset` 救不回。与 `accountListQuery` 同理走 forever,
    // 接上老 `syncStatusQuery` 的兜底(FOL-58 回归修复)。
    retry: (failureCount, error) => shouldRetry(failureCount, error, RETRY.forever),
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
