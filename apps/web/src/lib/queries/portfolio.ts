import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { HistoryRange } from "@/lib/core/history-range";
import {
  computeHomeTabStrip,
  type HomeTabStripView,
  type OverviewView,
} from "@/lib/core/portfolio";
import { getPortfolioHistory } from "@/lib/server/portfolio";
import { listPortfolios } from "@/lib/server/portfolios";
import { getPortfolioTabPins } from "@/lib/server/tab-pins";
import { RETRY, STALE_TIME, shouldRetry } from "./constants";
import { portfolioKeys } from "./keys";

// 组合域的读取入口 —— 与 `lib/server/portfolio`(读模型)+ `lib/server/portfolios`(实体)的读取型 server fn 对应。
//
// **`staleTime` 在 #412 打开**:这个域的写路径已经全部改成定向刷新,开缓存不会让任何一条
// 「改了东西画面要跟着动」的路径失灵。收益是页间来回切与 hover 预热不再重复打服务器 ——
// 首页 ⇄ 账户页 ⇄ 洞察页共用同一份总览,以前每次导航都真拉一遍。

/**
 * 一份组合总览的形状(按代币聚合的持仓 + 分段 + 小计)。消费方拆解 sections 时用得上。
 *
 * **它是原子 query 在浏览器合并的产物**(FOL-54 / FOL-56):接口发快照原料 + 富化 + 口径,
 * 总额 / 持仓 / 各小计 / 24h 盈亏 / pricesStale 由 `portfolioOverviewFromAtoms` 算出来。
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

export const portfolioHistoryQuery = (portfolioId: string, range: HistoryRange = "30d") =>
  queryOptions({
    queryKey: portfolioKeys.history(portfolioId, range),
    queryFn: () => getPortfolioHistory({ data: { portfolioId, range } }),
    staleTime: STALE_TIME.live,
  });
