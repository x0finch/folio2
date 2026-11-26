import { Skeleton, Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { StaggerReveal } from "@/components/page-switcher/stagger-reveal";
import { QueryBoundary } from "@/components/query-boundary";
import { toDailySeries, toPortfolioCurve } from "@/lib/core/history";
import { floorToHour } from "@/lib/core/portfolio";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { portfolioKeys } from "@/lib/queries/keys";
import { portfolioHistoryQuery } from "@/lib/queries/portfolio";
import { usePortfolioOverview } from "@/lib/queries/portfolio-overview-compose";
import { HeaderSync } from "@/routes/_authed/-home/header-sync";
import { ALLOC_DIMENSIONS, type AllocDimension, buildAllocation, DEFAULT_DIM } from "./allocation";
import { AllocationPie } from "./allocation-pie";
import { CHART_FRAME } from "./chart-frame";
import { PortfolioChart } from "./portfolio-chart";

// Retry forever here: this page shows the skeleton until success, never a failure message.
const KEEP_TRYING = { retry: true as const };

const DIM_LABEL: Record<AllocDimension, string> = {
  token: "byToken",
  chain: "byChain",
  account: "byAccount",
};

export function Insights() {
  return (
    <>
      {/* Outside the transform container, or its absolute positioning jumps (see StaggerReveal). */}
      <HeaderSync />
      <StaggerReveal className="flex flex-col gap-16">
        <TrendSection />
        <AllocationSection />
      </StaggerReveal>
    </>
  );
}

function TrendSection() {
  const t = useTranslations("Insights");
  const { selectedId } = usePortfolio();
  // Suspense + own boundary rather than `data == null` checks: SSR may already have the data while
  // the hydration frame's dehydrated cache doesn't, which would mismatch and re-render the subtree.
  const body = (
    <QueryBoundary
      resetKey={`insights-trend:${JSON.stringify(portfolioKeys.history(selectedId, "all"))}`}
      pending={<Skeleton className={CHART_FRAME} />}
      failed={<Skeleton className={CHART_FRAME} />}
    >
      <TrendReady portfolioId={selectedId} />
    </QueryBoundary>
  );
  return (
    <section className="flex flex-col gap-6">
      <h2 className="font-semibold text-lg">{t("trend")}</h2>
      {body}
    </section>
  );
}

function TrendReady({ portfolioId }: { portfolioId: string }) {
  const t = useTranslations("Insights");
  const { data } = useSuspenseQuery({
    ...portfolioHistoryQuery(portfolioId, "all"),
    ...KEEP_TRYING,
  });
  // The last point is replaced with the overview total so it matches the home page figure.
  const overview = usePortfolioOverview(portfolioId);
  const trend = useMemo(() => {
    const curve = toPortfolioCurve(data, overview);
    return data.sampled ? curve : toDailySeries(curve);
  }, [data, overview]);
  if (trend.length < 2) {
    return <p className="text-muted-foreground text-sm">{t("noData")}</p>;
  }
  return <PortfolioChart series={trend} />;
}

function AllocationReady({ portfolioId, dim }: { portfolioId: string; dim: AllocDimension }) {
  const overview = usePortfolioOverview(portfolioId);
  return <AllocationPie slices={buildAllocation(overview.holdings, dim)} />;
}

function AllocationSection() {
  const t = useTranslations("Insights");
  const { selectedId } = usePortfolio();
  const now = floorToHour(Date.now());
  const [dim, setDim] = useState<AllocDimension>(DEFAULT_DIM);
  const pie = (
    <QueryBoundary
      resetKey={`insights-alloc:${JSON.stringify(portfolioKeys.snapshots(selectedId, now))}`}
      pending={<Skeleton className={CHART_FRAME} />}
      failed={<Skeleton className={CHART_FRAME} />}
    >
      <AllocationReady portfolioId={selectedId} dim={dim} />
    </QueryBoundary>
  );
  return (
    <section className="flex flex-col gap-6">
      <h2 className="font-semibold text-lg">{t("allocation")}</h2>
      <Tabs value={dim} onValueChange={(v) => setDim(v as AllocDimension)} variant="underline">
        <TabsList>
          {ALLOC_DIMENSIONS.map((d) => (
            <TabsTrigger key={d} value={d}>
              {t(DIM_LABEL[d])}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {pie}
    </section>
  );
}
