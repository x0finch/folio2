import { Card, CardContent, CardHeader, CardTitle, Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { useSuspenseQuery } from "@tanstack/react-query";
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
import {
  portfolioHistoryQuery,
  portfolioListQuery,
  portfolioOverviewQuery,
} from "../../lib/queries/portfolio";

// 洞察:组合走势(复用 history)+ 分配饼图 + 维度切换(代币/链/账户)。读时算,复用 overview 的 holdings。
export const Route = createFileRoute("/_authed/insights")({
  // 与首页同款(ADR 0038):loader 只按**默认组合**预取,组件按选中的组合 id 从缓存读。
  loader: async ({ context: { queryClient } }) => {
    const { defaultId } = await queryClient.ensureQueryData(portfolioListQuery());
    await Promise.all([
      queryClient.ensureQueryData(portfolioOverviewQuery(defaultId)),
      queryClient.ensureQueryData(portfolioHistoryQuery(defaultId)),
    ]);
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
  const { selectedId } = usePortfolio();
  // 默认与非默认走同一个查询工厂,只是 portfolioId 不同 —— 以前是「默认走 loader、非默认走另一个
  // useQuery」,两边 key 不同族,整页刷新碰不到后者(停在非默认组合上写完画面不动)。
  const { data: overview } = useSuspenseQuery(portfolioOverviewQuery(selectedId));
  const { data: history } = useSuspenseQuery(portfolioHistoryQuery(selectedId));
  const t = useTranslations("Insights");
  const [dim, setDim] = useState<AllocDimension>("token");
  const { holdings } = overview;
  const { series } = history;
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
