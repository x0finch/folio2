import { queryOptions } from "@tanstack/react-query";
import {
  getHomeTabStrip,
  getPortfolioGain24h,
  getPortfolioHistory,
  getPortfolioOverview,
} from "../server/portfolio";
import { listPortfolioMemberships, listPortfolios } from "../server/portfolios";
import { STALE_TIME } from "./constants";
import { type PinScopeKey, portfolioKeys } from "./keys";

// 组合域的读取入口 —— 与 `lib/server/portfolio`(读模型)+ `lib/server/portfolios`(实体)的读取型 server fn 对应。
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

/** 首页 tab 条:有没有永续 / DeFi + 自定义 Tab 的已解析标签。 */
export type HomeTabStrip = Awaited<ReturnType<typeof getHomeTabStrip>>;

export const homeTabStripQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: portfolioKeys.tabStrip(portfolioId),
    queryFn: () => getHomeTabStrip({ data: { portfolioId } }),
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

export const portfolioHistoryQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: portfolioKeys.history(portfolioId),
    queryFn: () => getPortfolioHistory({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
  });

/** 24h 盈亏:组合级 + 按持仓 / DeFi 协议分组。自定义 Tab 把 pin 传进来。 */
export const portfolioGain24hQuery = (portfolioId: string, pin?: PinScopeKey) =>
  queryOptions({
    queryKey: portfolioKeys.gain24h(portfolioId, pin),
    queryFn: () => getPortfolioGain24h({ data: { portfolioId, pin } }),
    staleTime: STALE_TIME.live,
  });
