import { type QueryClient, queryOptions } from "@tanstack/react-query";
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
import { type PinScopeKey, portfolioKeys, tagKeys } from "./keys";
import type { TagList } from "./tags";

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

/** 首页 tab 条 pin 原料 —— 只含 pin 行;账户/快照走 overview 缓存,标签走 tagListQuery。 */
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
  const tabPins = await queryClient.fetchQuery({
    ...portfolioTabPinsQuery(portfolioId),
    staleTime: 0,
  });
  const snapshot = queryClient.getQueryData<PortfolioSnapshotData>(
    portfolioKeys.overview(portfolioId),
  );
  const tags = queryClient.getQueryData<TagList>(tagKeys.list(portfolioId));
  if (!snapshot || !tags) {
    throw new Error("fetchHomeTabStrip: overview or tags missing from query cache");
  }
  return computeHomeTabStrip(snapshot, tabPins, tags);
};

// 一份总览 = 一个组合口径(+ 可选的自定义 Tab 收窄)。默认视图与非默认视图、Tab 视图走的是
// **同一个工厂**,只是参数不同 —— 这正是「一句前缀刷新盖住三种视图」的前提。
//
// **一份原料一个 queryKey,`select` 现算**(FOL-48):接口发的是当前快照原料,总额 / 持仓 /
// 各小计 / pricesStale 由 `overviewFromSnapshotData` 在浏览器里算 —— 单币当前价值也从**同一份
// select 结果**里取一行,不单独请求(FOL-44 定的共用)。`select` 只在原料变化时重跑,SSR 与
// 补水两遍算的是同一份原料 → 结果一致,不会 hydration mismatch。
//
// 首次同步中的加载态:有账户、还没有任何快照时 `select` 判出 `pending`,首页 hero 显加载态
// 而不是把「还不知道」画成 $0;拿到第一张快照(`pending` 转 false)就停(`pollWhilePending`)。
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

export const portfolioHistoryQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: portfolioKeys.history(portfolioId),
    queryFn: () => getPortfolioHistory({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
  });
