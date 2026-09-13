import type { QueryClient } from "@tanstack/react-query";
import { lazy } from "react";
import type { SwitcherPage } from "@/components/page-switcher";
import {
  prefetchAccounts,
  prefetchInsights,
  prefetchOverview,
  prefetchSettings,
} from "@/lib/queries/prefetch-pages";
import type { PageKey } from "./-page-keys";
import {
  AccountsSkeleton,
  InsightsSkeleton,
  OverviewSkeleton,
  SettingsSkeleton,
} from "./-page-skeletons";

// 四个 page 的注册表(FOL-81)—— **关于「一页」的一切都在这一行里**:懒加载组件、它自己的骨架、
// 它的 chunk 加载器、它的数据预取。切换器、路由 loader、导航预热三处都只查这张表,加第五页只改这里。
//
// chunk 加载器写成具名函数:module registry 天然对同一个动态 import 去重,所以 Dock 在 `pointerdown`
// 时提前调 `load()` 预热,与 `React.lazy` 内部再调命中的是**同一个** module promise —— 不必像 spike
// 里那样手写 `once()`。
const loadOverview = () => import("./-home").then((m) => ({ default: m.Overview }));
const loadAccounts = () => import("./-accounts").then((m) => ({ default: m.Accounts }));
const loadInsights = () => import("./-insights").then((m) => ({ default: m.Insights }));
const loadSettings = () => import("./-settings").then((m) => ({ default: m.Settings }));

interface PageEntry extends SwitcherPage<PageKey> {
  /** 拉这一页的 chunk(不 await);与 `Component` 里的 `lazy` 共享同一个 module promise。 */
  load: () => Promise<unknown>;
  /** 这一页的数据预取(发出即返回,见 prefetch-pages)。设置页不读组合,忽略第二个参数。 */
  prefetch: (queryClient: QueryClient, selectedId: string) => void;
}

export const PAGES: readonly PageEntry[] = [
  {
    key: "overview",
    load: loadOverview,
    Component: lazy(loadOverview),
    Skeleton: OverviewSkeleton,
    prefetch: prefetchOverview,
  },
  {
    key: "accounts",
    load: loadAccounts,
    Component: lazy(loadAccounts),
    Skeleton: AccountsSkeleton,
    prefetch: prefetchAccounts,
  },
  {
    key: "insights",
    load: loadInsights,
    Component: lazy(loadInsights),
    Skeleton: InsightsSkeleton,
    prefetch: prefetchInsights,
  },
  {
    key: "settings",
    load: loadSettings,
    Component: lazy(loadSettings),
    Skeleton: SettingsSkeleton,
    prefetch: prefetchSettings,
  },
];

const BY_KEY = Object.fromEntries(PAGES.map((p) => [p.key, p])) as Record<PageKey, PageEntry>;

// 预热一页 = 拉 chunk(不 await)+ 按选中组合预取该页数据。两处调用:路由 loader(进入某页)与
// Dock / 侧栏的 `onPointerDown`(意图)。严格 lazy 的补充:默认不预热任何东西,只有真要去某页、
// 或指针按在它的导航项上,才提前拉它一个。
export function prefetchPage(key: PageKey, queryClient: QueryClient, selectedId: string) {
  const entry = BY_KEY[key];
  entry.load();
  entry.prefetch(queryClient, selectedId);
}
