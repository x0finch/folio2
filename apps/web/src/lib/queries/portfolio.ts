import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { HistoryRange } from "@/lib/core/history-range";
import {
  computeHomeTabStrip,
  type HomeTabStripView,
  isFirstSyncPending,
  type OverviewView,
  overviewFromSnapshotData,
  type PortfolioSnapshotData,
} from "@/lib/core/portfolio";
import { getPortfolioHistory, getPortfolioSnapshotData } from "@/lib/server/portfolio";
import { listPortfolios } from "@/lib/server/portfolios";
import { getPortfolioTabPins } from "@/lib/server/tab-pins";
import { pollWhilePending, RETRY, STALE_TIME, shouldRetry } from "./constants";
import { type PinScopeKey, portfolioKeys } from "./keys";

// 组合域的读取入口 —— 与 `lib/server/portfolio`(读模型)+ `lib/server/portfolios`(实体)的读取型 server fn 对应。
//
// **`staleTime` 在 #412 打开**:这个域的写路径已经全部改成定向刷新,开缓存不会让任何一条
// 「改了东西画面要跟着动」的路径失灵。收益是页间来回切与 hover 预热不再重复打服务器 ——
// 首页 ⇄ 账户页 ⇄ 洞察页共用同一份总览,以前每次导航都真拉一遍。

/**
 * 一份组合总览的形状(按代币聚合的持仓 + 分段 + 小计)。消费方拆解 sections 时用得上。
 *
 * **它是 `select` 的产物**(FOL-48 / FOL-51):接口发的是当前 + 24 小时前两组快照原料,总额 /
 * 持仓 / 各小计 / 24h 盈亏 / pricesStale 由 `overviewFromSnapshotData` 在浏览器里算出来 —— 所以类型
 * 就是 `buildOverview` 的出参(含各级 `gain24h`),外加一个 `pending`:**首次同步中**(有账户、还没有
 * 任何快照)。它是 `select` 从原料判出来的、不进 `overviewFromSnapshotData`,首页据此显加载态而非 $0。
 */
export type PortfolioOverview = OverviewView & { pending: boolean };

export const portfolioListQuery = () =>
  queryOptions({
    queryKey: portfolioKeys.list(),
    queryFn: () => listPortfolios(),
    staleTime: STALE_TIME.live,
    retry: (failureCount, error) => shouldRetry(failureCount, error, RETRY.forever),
  });

/** 首页 tab 条 pin 原料 —— 只含 pin 行;账户/快照走原子 query 缓存,标签走 tagListQuery。 */
export const portfolioTabPinsQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: portfolioKeys.tabPins(portfolioId),
    queryFn: () => getPortfolioTabPins({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
  });

export type HomeTabStrip = HomeTabStripView;

/** pin 写路径等「等条子真的变了」时用 —— 只重拉 tabPins,其余从 query 缓存合并。 */
export const fetchHomeTabStrip = async (
  queryClient: QueryClient,
  portfolioId: string,
): Promise<HomeTabStrip> => {
  const { fetchPortfolioSnapshotAtoms } = await import("./portfolio-overview-compose");
  const [tabPins, snapshot, tags] = await Promise.all([
    queryClient.fetchQuery({ ...portfolioTabPinsQuery(portfolioId), staleTime: 0 }),
    fetchPortfolioSnapshotAtoms(queryClient, portfolioId),
    queryClient.fetchQuery({ ...(await import("./tags")).tagListQuery(portfolioId), staleTime: 0 }),
  ]);
  return computeHomeTabStrip(snapshot, tabPins, tags);
};

// 洞察页等仍走这条(FOL-59 前保留)。首页已改原子 query + `usePortfolioOverview`。
const selectOverview = (raw: PortfolioSnapshotData): PortfolioOverview => ({
  ...overviewFromSnapshotData(raw),
  pending: isFirstSyncPending(raw),
});

export const portfolioOverviewQuery = (portfolioId: string, pin?: PinScopeKey) =>
  queryOptions({
    queryKey: portfolioKeys.overview(portfolioId, pin),
    queryFn: () => getPortfolioSnapshotData({ data: { portfolioId, pin } }),
    select: selectOverview,
    staleTime: STALE_TIME.live,
    refetchInterval: (query) => pollWhilePending(query, isFirstSyncPending(query.state.data)),
  });

export const portfolioHistoryQuery = (portfolioId: string, range: HistoryRange = "30d") =>
  queryOptions({
    queryKey: portfolioKeys.history(portfolioId, range),
    queryFn: () => getPortfolioHistory({ data: { portfolioId, range } }),
    staleTime: STALE_TIME.live,
  });
