import type { QueryClient } from "@tanstack/react-query";
import { lazy } from "react";
import type { SwitcherPage } from "@/components/page-switcher";
import {
  prefetchAccounts,
  prefetchInsights,
  prefetchOverview,
  prefetchSettings,
} from "@/lib/queries/prefetch-pages";
import { PageContentSkeleton } from "./-page-content-skeleton";

// 四个 page 的注册表(FOL-81):懒加载组件 + 各自的骨架,交给 `PageSwitcher`。
//
// chunk 加载器写成具名函数:module registry 天然对同一个动态 import 去重,所以 Dock 在 `pointerdown`
// 时提前调 `load*()` 预热,与 `React.lazy` 内部再调命中的是**同一个** module promise —— 不必像 spike
// 里那样手写 `once()`。
const loadOverview = () => import("./-home").then((m) => ({ default: m.Overview }));
const loadAccounts = () => import("./-accounts").then((m) => ({ default: m.Accounts }));
const loadInsights = () => import("./-insights").then((m) => ({ default: m.Insights }));
const loadSettings = () => import("./-settings").then((m) => ({ default: m.Settings }));

const PAGE_KEYS = ["overview", "accounts", "insights", "settings"] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export const PAGES: SwitcherPage[] = [
  { key: "overview", Component: lazy(loadOverview), Skeleton: PageContentSkeleton },
  { key: "accounts", Component: lazy(loadAccounts), Skeleton: PageContentSkeleton },
  { key: "insights", Component: lazy(loadInsights), Skeleton: PageContentSkeleton },
  { key: "settings", Component: lazy(loadSettings), Skeleton: PageContentSkeleton },
];

const CHUNK: Record<PageKey, () => Promise<unknown>> = {
  overview: loadOverview,
  accounts: loadAccounts,
  insights: loadInsights,
  settings: loadSettings,
};

// 意图预热(Dock / 侧栏 `onPointerDown`):先把 chunk 拉起来(不 await),再按选中组合预取该页数据。
// 严格 lazy 的补充:默认不预热任何东西,只有指针按在某个 tab 上才提前拉它一个。
export function prefetchPage(key: PageKey, queryClient: QueryClient, selectedId: string) {
  CHUNK[key]();
  if (key === "accounts") prefetchAccounts(queryClient, selectedId);
  else if (key === "insights") prefetchInsights(queryClient, selectedId);
  else if (key === "settings") prefetchSettings(queryClient);
  else prefetchOverview(queryClient, selectedId);
}
