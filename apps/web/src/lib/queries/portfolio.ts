import { queryOptions } from "@tanstack/react-query";
import {
  getPortfolioHistory,
  getPortfolioOverview,
  listPortfolioMemberships,
  listPortfolios,
} from "../server/portfolio";
import { listTabPins } from "../server/tab-pins";
import { type PinScopeKey, portfolioKeys } from "./keys";

// 组合域的读取入口 —— 与 `lib/server/portfolio.ts` / `lib/server/tab-pins.ts` 的读取型 server fn 对应。
//
// **本片一律不设 `staleTime`(即 0)。** 组合的写路径还没迁,它们仍靠整页 `router.invalidate()`,
// 而那条路只在数据 stale 时才真拉 —— 现在开缓存,新建/改名/删除组合就会静默地不刷新。
// 写路径迁完的那一片(#412)再开。

/** 一份组合总览的形状(按代币聚合的持仓 + 分段 + 小计)。消费方拆解 sections 时用得上。 */
export type PortfolioOverview = Awaited<ReturnType<typeof getPortfolioOverview>>;

export const portfolioListQuery = () =>
  queryOptions({ queryKey: portfolioKeys.list(), queryFn: () => listPortfolios() });

export const portfolioMembershipsQuery = () =>
  queryOptions({
    queryKey: portfolioKeys.memberships(),
    queryFn: () => listPortfolioMemberships(),
  });

export const tabPinsQuery = () =>
  queryOptions({ queryKey: portfolioKeys.pins(), queryFn: () => listTabPins() });

// 一份总览 = 一个组合口径(+ 可选的自定义 Tab 收窄)。默认视图与非默认视图、Tab 视图走的是
// **同一个工厂**,只是参数不同 —— 这正是「一句前缀刷新盖住三种视图」的前提。
export const portfolioOverviewQuery = (portfolioId: string, pin?: PinScopeKey) =>
  queryOptions({
    queryKey: portfolioKeys.overview(portfolioId, pin),
    queryFn: () => getPortfolioOverview({ data: { portfolioId, pin } }),
  });

export const portfolioHistoryQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: portfolioKeys.history(portfolioId),
    queryFn: () => getPortfolioHistory({ data: { portfolioId } }),
  });
