import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { computeHomeTabStrip, type HomeTabStripView } from "@/lib/core/portfolio";
import { portfolioTabPinsQuery } from "@/lib/queries/portfolio";
import { usePortfolioSnapshotAtoms } from "@/lib/queries/portfolio-overview-compose";
import { tagListQuery } from "@/lib/queries/tags";

export function useHomeTabStrip(portfolioId: string): HomeTabStripView {
  const snapshot = usePortfolioSnapshotAtoms(portfolioId);
  const { data: tabPins } = useSuspenseQuery(portfolioTabPinsQuery(portfolioId));
  const { data: tags } = useSuspenseQuery(tagListQuery(portfolioId));

  return useMemo(() => computeHomeTabStrip(snapshot, tabPins, tags), [snapshot, tabPins, tags]);
}
