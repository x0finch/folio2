import { queryOptions } from "@tanstack/react-query";
import {
  getHomeTabMeta,
  getPortfolioGains,
  getPortfolioHistory,
  getPortfolioOverview,
  listPortfolioMemberships,
  listPortfolios,
} from "../server/portfolio";
import { STALE_TIME } from "./constants";
import { type PinScopeKey, portfolioKeys } from "./keys";

// 组合域的读取入口 —— 与 `lib/server/portfolio.ts` / `lib/server/tab-pins.ts` 的读取型 server fn 对应。
//
// **`staleTime` 在 #412 打开**:这个域的写路径已经全部改成定向刷新,开缓存不会让任何一条
// 「改了东西画面要跟着动」的路径失灵。收益是页间来回切与 hover 预热不再重复打服务器 ——
// 首页 ⇄ 账户页 ⇄ 洞察页共用同一份总览,以前每次导航都真拉一遍。

/** 一份组合总览的形状(按代币聚合的持仓 + 分段 + 小计)。消费方拆解 sections 时用得上。 */
export type PortfolioOverview = Awaited<ReturnType<typeof getPortfolioOverview>>;

export const portfolioListQuery = () =>
  queryOptions({
    queryKey: portfolioKeys.list(),
    queryFn: () => listPortfolios(),
    staleTime: STALE_TIME.live,
  });

export const portfolioMembershipsQuery = () =>
  queryOptions({
    queryKey: portfolioKeys.memberships(),
    queryFn: () => listPortfolioMemberships(),
    staleTime: STALE_TIME.live,
  });

// 一份总览 = 一个组合口径(+ 可选的自定义 Tab 收窄)。默认视图与非默认视图、Tab 视图走的是
// **同一个工厂**,只是参数不同 —— 这正是「一句前缀刷新盖住三种视图」的前提。
export const portfolioOverviewQuery = (portfolioId: string, pin?: PinScopeKey) =>
  queryOptions({
    queryKey: portfolioKeys.overview(portfolioId, pin),
    queryFn: () => getPortfolioOverview({ data: { portfolioId, pin } }),
    staleTime: STALE_TIME.live,
  });

// 24h 盈亏,**与总览分开的一条读**(#488)。慢的是它(快照历史 + 手记账本现算),
// 所以列表与总净值不等它 —— 它回来之前那些位置是骨架,回来了再贴上去(见 lib/gain-merge)。
export const portfolioGainsQuery = (portfolioId: string, pin?: PinScopeKey) =>
  queryOptions({
    queryKey: portfolioKeys.gains(portfolioId, pin),
    queryFn: () => getPortfolioGains({ data: { portfolioId, pin } }),
    staleTime: STALE_TIME.live,
  });

export const portfolioHistoryQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: portfolioKeys.history(portfolioId),
    queryFn: () => getPortfolioHistory({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
  });

// 首页 tab 条要的一切,一条轻请求答完。**和总览分开**是为了让 tab 条能先出现 ——
// 合进总览就又变成「等最慢的那个」,那正是四拍要拆开的东西。
export const homeTabMetaQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: portfolioKeys.tabMeta(portfolioId),
    queryFn: () => getHomeTabMeta({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
  });
