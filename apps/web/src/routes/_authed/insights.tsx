import { Card, CardContent, CardHeader, CardTitle, Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { AllocationPie } from "../../components/allocation-pie";
import { HeaderSync } from "../../components/header-sync";
import { PortfolioChart } from "../../components/portfolio-chart";
import { InsightsSkeleton } from "../../components/skeletons";
import { type AllocDimension, buildAllocation } from "../../lib/allocation";
import { toDailySeries } from "../../lib/history";
import { usePortfolio } from "../../lib/hooks/use-portfolio";
import { getPortfolioHistory, getPortfolioOverview } from "../../lib/server/portfolio";

// 洞察:组合走势(复用 history)+ 分配饼图 + 维度切换(代币/链/账户)。读时算,复用 overview 的 holdings。
export const Route = createFileRoute("/_authed/insights")({
  loader: async () => {
    const [overview, history] = await Promise.all([getPortfolioOverview(), getPortfolioHistory()]);
    return { holdings: overview.holdings, series: history.series };
  },
  pendingComponent: InsightsSkeleton,
  component: Insights,
});

const DIMS = [
  { key: "token", label: "byToken" },
  { key: "chain", label: "byChain" },
  { key: "account", label: "byAccount" },
] as const;

function Insights() {
  const { selectedId, defaultId } = usePortfolio();
  const loaderData = Route.useLoaderData(); // SSR 默认视图
  const isDefault = selectedId === defaultId;
  // 与主页同款:非默认 Portfolio 客户端按 selectedId 重拉;默认走 loader。
  const scopedQuery = useQuery({
    queryKey: ["insights", selectedId],
    queryFn: async () => {
      const [overview, history] = await Promise.all([
        getPortfolioOverview({ data: { portfolioId: selectedId } }),
        getPortfolioHistory({ data: { portfolioId: selectedId } }),
      ]);
      return { holdings: overview.holdings, series: history.series };
    },
    enabled: !isDefault,
    placeholderData: keepPreviousData,
  });
  const data = isDefault ? loaderData : scopedQuery.data;
  const t = useTranslations("Insights");
  const [dim, setDim] = useState<AllocDimension>("token");
  if (!data) return <InsightsSkeleton />;
  const { holdings, series } = data;
  const slices = buildAllocation(holdings, dim);
  // 这张图的 X 轴只标到「日」→ 粒度必须配得上,否则同一天多次同步会印出重复的日期刻度。
  const trend = toDailySeries(series);

  return (
    <div className="flex flex-col gap-6">
      <HeaderSync />
      <Card>
        <CardHeader>
          <CardTitle>{t("trend")}</CardTitle>
        </CardHeader>
        <CardContent>
          {trend.length < 2 ? (
            <p className="text-muted-foreground text-sm">{t("noData")}</p>
          ) : (
            <PortfolioChart series={trend} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("allocation")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Tabs value={dim} onValueChange={(v) => setDim(v as AllocDimension)} variant="underline">
            <TabsList>
              {DIMS.map((d) => (
                <TabsTrigger key={d.key} value={d.key}>
                  {t(d.label)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <AllocationPie slices={slices} />
        </CardContent>
      </Card>
    </div>
  );
}
