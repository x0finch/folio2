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

// Page registry: everything about a page lives in one entry. Named loaders matter: the module
// registry dedupes the dynamic import, so warming with `load()` shares React.lazy's promise.
const loadOverview = () => import("./-home").then((m) => ({ default: m.Overview }));
const loadAccounts = () => import("./-accounts").then((m) => ({ default: m.Accounts }));
const loadInsights = () => import("./-insights").then((m) => ({ default: m.Insights }));
const loadSettings = () => import("./-settings").then((m) => ({ default: m.Settings }));

interface PageEntry extends SwitcherPage<PageKey> {
  load: () => Promise<unknown>;
  /** Fire-and-forget. Settings ignores `selectedId`. */
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

export function prefetchPage(key: PageKey, queryClient: QueryClient, selectedId: string) {
  const entry = BY_KEY[key];
  entry.load();
  entry.prefetch(queryClient, selectedId);
}
