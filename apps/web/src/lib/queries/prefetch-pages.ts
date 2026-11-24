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

// Per-page data prefetch shared by route loaders and the page switcher's pointerdown warm-up. `selectedId` comes from the
// caller. Nothing is awaited: every `ensureQueryData` fires and returns.
// Shared by overview and insights, which both compose the overview in the browser from the same atoms. `now` is
// hour-floored, deliberately different from the accounts page's `accountHoldingsSnapshotTimes()` anchor (see prefetchAccounts).
function prefetchOverviewAtoms(queryClient: QueryClient, selectedId: string) {
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
}

export function prefetchOverview(queryClient: QueryClient, selectedId: string) {
  prefetchOverviewAtoms(queryClient, selectedId);
  // Overview only: tab strip pins, tag list, 30-day trend.
  queryClient.ensureQueryData(portfolioTabPinsQuery(selectedId));
  queryClient.ensureQueryData(tagListQuery(selectedId));
  queryClient.ensureQueryData(portfolioHistoryQuery(selectedId, "30d"));
}

export function prefetchAccounts(queryClient: QueryClient, selectedId: string) {
  // Every row shows a connector badge; without this the first frame shows fallback names. Static per deployment.
  queryClient.ensureQueryData(connectorCatalogQuery());
  queryClient.ensureQueryData(accountListQuery(selectedId));
  queryClient.ensureQueryData(tagListQuery(selectedId));
  queryClient.ensureQueryData(accountTagLinksQuery(selectedId));
  // Holdings are composed in the browser; the snapshot anchor is accountHoldingsSnapshotTimes(), not overview's floorToHour(now).
  const { anchor } = accountHoldingsSnapshotTimes();
  const snapshots = accountHoldingsSnapshotQueries(selectedId, anchor);
  queryClient.ensureQueryData(snapshots.now);
  queryClient.ensureQueryData(snapshots.prev);
  queryClient.ensureQueryData(valuationSettingsQuery());
  queryClient.ensureQueryData(tokenEnrichmentQuery());
}

export function prefetchInsights(queryClient: QueryClient, selectedId: string) {
  prefetchOverviewAtoms(queryClient, selectedId);
  // Insights only: full-range trend (overview uses "30d"); no portfolioTabPins / tagList.
  queryClient.ensureQueryData(portfolioHistoryQuery(selectedId, "all"));
}

export function prefetchSettings(queryClient: QueryClient) {
  // Settings doesn't read portfolios: these three don't depend on selectedId.
  queryClient.ensureQueryData(providerKeyStatusQuery());
  queryClient.ensureQueryData(valuationSettingsQuery());
  queryClient.ensureQueryData(dataStatsQuery());
}
