import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { QueryBoundary } from "@/components/query-boundary";
import { toPortfolioCurve } from "@/lib/core/history";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { portfolioKeys } from "@/lib/queries/keys";
import { type PortfolioOverview, portfolioHistoryQuery } from "@/lib/queries/portfolio";
import { usePortfolioOverview } from "@/lib/queries/portfolio-overview-compose";
import { PortfolioHero } from "./portfolio-hero";

// The total and 24h PnL come from the overview (the outer boundary already awaited it); only the
// curve arrives later. The curve suspends inside its own boundary rather than `useQuery` +
// `isPending`: on SSR the loader's request has usually finished (data) while the hydration frame's
// dehydrated cache lacks it (skeleton), which makes React discard the subtree.
export function HeroIsland() {
  const { selectedId } = usePortfolio();
  const data = usePortfolioOverview(selectedId);
  // First sync (accounts but no snapshot yet): don't draw "unknown" as $0; the whole hero loads.
  // The overview polls, so `pending` flips off after the first snapshot.
  if (data.pending) return <HeroShell overview={data} loading syncing />;
  return (
    <QueryBoundary
      resetKey={`hero-curve:${JSON.stringify(portfolioKeys.history(selectedId, "30d"))}`}
      // Loading: total / PnL render, the curve shows its loading state.
      pending={<HeroShell overview={data} loading />}
      // Failed: total / PnL stay, the curve area collapses to empty.
      failed={<HeroShell overview={data} />}
    >
      <HeroReady overview={data} portfolioId={selectedId} />
    </QueryBoundary>
  );
}

// One call shared by all three states; they differ only in loading and the late curve.
function HeroShell({
  overview,
  series = [],
  loading = false,
  syncing = false,
}: {
  overview: PortfolioOverview;
  series?: React.ComponentProps<typeof PortfolioHero>["series"];
  loading?: boolean;
  syncing?: boolean;
}) {
  return (
    <PortfolioHero
      series={series}
      loading={loading}
      totalUsd={overview.totalUsd}
      gain24h={overview.gain24h ?? null}
      syncing={syncing}
      holdings={overview.holdings}
    />
  );
}

// The suspend point: renders once the curve arrives.
function HeroReady({
  overview,
  portfolioId,
}: {
  overview: PortfolioOverview;
  portfolioId: string;
}) {
  const history = useSuspenseQuery(portfolioHistoryQuery(portfolioId, "30d"));
  // Curve is computed in the browser from raw snapshot points; the last point comes from the
  // overview's per-account table so the big number and the curve's right end match. Memoized
  // because scrubbing re-renders the hero on every frame.
  const series = useMemo(() => toPortfolioCurve(history.data, overview), [history.data, overview]);
  return (
    <PortfolioHero
      series={series}
      totalUsd={overview.totalUsd}
      gain24h={overview.gain24h ?? null}
      holdings={overview.holdings}
    />
  );
}
