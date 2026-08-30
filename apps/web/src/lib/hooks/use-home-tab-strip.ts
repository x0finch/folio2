import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  computeHomeTabStrip,
  type HomeTabStripView,
  type PortfolioSnapshotData,
  type PortfolioTabPinsData,
} from "@/lib/core/portfolio";
import { portfolioKeys, tagKeys } from "@/lib/queries/keys";
import { portfolioOverviewQuery, portfolioTabPinsQuery } from "@/lib/queries/portfolio";
import { type TagList, tagListQuery } from "@/lib/queries/tags";

/** 首页 tab 条:overview 快照缓存 + tabPins + 标签列表,浏览器 `computeHomeTabStrip` 现算。 */
export function useHomeTabStrip(portfolioId: string): HomeTabStripView {
  const queryClient = useQueryClient();
  useSuspenseQuery(portfolioOverviewQuery(portfolioId));
  useSuspenseQuery(portfolioTabPinsQuery(portfolioId));
  useSuspenseQuery(tagListQuery(portfolioId));

  const snapshot = queryClient.getQueryData<PortfolioSnapshotData>(
    portfolioKeys.overview(portfolioId),
  );
  const tabPins = queryClient.getQueryData<PortfolioTabPinsData>(
    portfolioKeys.tabPins(portfolioId),
  );
  const tags = queryClient.getQueryData<TagList>(tagKeys.list(portfolioId));

  return useMemo(() => {
    if (!snapshot || !tabPins || !tags) {
      throw new Error("home tab strip prerequisites missing from query cache");
    }
    return computeHomeTabStrip(snapshot, tabPins, tags);
  }, [snapshot, tabPins, tags]);
}
