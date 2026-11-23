import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { HistoryRange } from "@/lib/core/history-range";
import { readJson } from "@/lib/core/json-response";
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

// Portfolio-domain reads. `staleTime` is on because every write path refreshes by targeted invalidation, so caching
// can't leave a stale screen; home / accounts / insights share one overview instead of refetching per navigation.

/** Overview shape (holdings aggregated by token + sections + subtotals), composed in the browser from atom queries by `portfolioOverviewFromAtoms`. */
export type PortfolioOverview = OverviewView & { pending: boolean };

export const portfolioListQuery = () =>
  queryOptions({
    queryKey: portfolioKeys.list(),
    queryFn: () => listPortfolios(),
    staleTime: STALE_TIME.live,
    retry: (failureCount, error) => shouldRetry(failureCount, error, RETRY.forever),
  });

/** Pin rows for the home tab strip; accounts / snapshots come from atom queries, tags from tagListQuery. */
export const portfolioTabPinsQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: portfolioKeys.tabPins(portfolioId),
    queryFn: () => getPortfolioTabPins({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
  });

export type HomeTabStrip = HomeTabStripView;

/** For pin writes: refetch only tabPins, merge the rest from the query cache. */
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
    queryFn: async () => readJson(await getPortfolioHistory({ data: { portfolioId, range } })),
    staleTime: STALE_TIME.live,
  });
