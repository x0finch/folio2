import type { QueryClient } from "@tanstack/react-query";
import { floorToHour } from "@/lib/core/portfolio";
import { accountListQuery } from "@/lib/queries/accounts";
import { connectorCatalogQuery } from "@/lib/queries/connectors";
import { portfolioHistoryQuery, portfolioTabPinsQuery } from "@/lib/queries/portfolio";
import { fiatRefsQuery } from "@/lib/queries/portfolio-overview-compose";
import {
  dataStatsQuery,
  providerKeyStatusQuery,
  valuationSettingsQuery,
} from "@/lib/queries/settings";
import {
  accountHoldingsSnapshotQueries,
  accountHoldingsSnapshotTimes,
} from "@/lib/queries/snapshots";
import { accountTagLinksQuery, tagListQuery } from "@/lib/queries/tags";
import { tokenEnrichmentQuery } from "@/lib/queries/tokens";

// 各 page 的数据预取,从原四个路由 loader 的身体抽出(FOL-80)。
//
// 一份两用:路由 loader 与 page 切换器的 pointerdown 预热共用同一个函数。`selectedId` 由调用方给
// —— loader 从 `portfolioListQuery` 解析出来,切换器从 `usePortfolio()` 拿。这几个函数**不 await**:
// 全部 `ensureQueryData` 发出即返回,谁先回来谁先画(#488 / #493),等「是哪个组合」是调用方的事。

export function prefetchOverview(queryClient: QueryClient, selectedId: string) {
  const now = floorToHour(Date.now());
  const snapshotQueries = accountHoldingsSnapshotQueries(selectedId, now);
  queryClient.ensureQueryData(accountListQuery(selectedId));
  queryClient.ensureQueryData(accountTagLinksQuery(selectedId));
  queryClient.ensureQueryData(snapshotQueries.now);
  queryClient.ensureQueryData(snapshotQueries.prev);
  queryClient.ensureQueryData(valuationSettingsQuery());
  queryClient.ensureQueryData(tokenEnrichmentQuery());
  queryClient.ensureQueryData(connectorCatalogQuery());
  queryClient.ensureQueryData(fiatRefsQuery(selectedId));
  queryClient.ensureQueryData(portfolioTabPinsQuery(selectedId));
  queryClient.ensureQueryData(tagListQuery(selectedId));
  queryClient.ensureQueryData(portfolioHistoryQuery(selectedId, "30d"));
}

export function prefetchAccounts(queryClient: QueryClient, selectedId: string) {
  // connector 展示名目录:本页每一行都有徽标,不预取首帧只能显兜底名(#467)。部署内静态、缓存一次。
  queryClient.ensureQueryData(connectorCatalogQuery());
  queryClient.ensureQueryData(accountListQuery(selectedId));
  queryClient.ensureQueryData(tagListQuery(selectedId));
  queryClient.ensureQueryData(accountTagLinksQuery(selectedId));
  // 持仓由原子资源在浏览器合并(FOL-55):快照(当下 + 24h 前)锚用 accountHoldingsSnapshotTimes(),
  // 与总览/洞察的 floorToHour(now) 不同,别统一。
  const { anchor } = accountHoldingsSnapshotTimes();
  const snapshots = accountHoldingsSnapshotQueries(selectedId, anchor);
  queryClient.ensureQueryData(snapshots.now);
  queryClient.ensureQueryData(snapshots.prev);
  queryClient.ensureQueryData(valuationSettingsQuery());
  queryClient.ensureQueryData(tokenEnrichmentQuery());
}

export function prefetchInsights(queryClient: QueryClient, selectedId: string) {
  const now = floorToHour(Date.now());
  const snapshotQueries = accountHoldingsSnapshotQueries(selectedId, now);
  queryClient.ensureQueryData(accountListQuery(selectedId));
  queryClient.ensureQueryData(accountTagLinksQuery(selectedId));
  queryClient.ensureQueryData(snapshotQueries.now);
  queryClient.ensureQueryData(snapshotQueries.prev);
  queryClient.ensureQueryData(valuationSettingsQuery());
  queryClient.ensureQueryData(tokenEnrichmentQuery());
  queryClient.ensureQueryData(connectorCatalogQuery());
  queryClient.ensureQueryData(fiatRefsQuery(selectedId));
  // 洞察与总览几乎同,差异:不取 portfolioTabPins / tagList;历史区间是 "all"(总览是 "30d")。
  queryClient.ensureQueryData(portfolioHistoryQuery(selectedId, "all"));
}

export function prefetchSettings(queryClient: QueryClient) {
  // 设置页不读组合:三条与 selectedId 无关。
  queryClient.ensureQueryData(providerKeyStatusQuery());
  queryClient.ensureQueryData(valuationSettingsQuery());
  queryClient.ensureQueryData(dataStatsQuery());
}
