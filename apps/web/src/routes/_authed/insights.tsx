import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Tabs,
  TabsListThin,
  TabsTriggerThin,
} from "@folio/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { AllocationPie } from "../../components/allocation-pie";
import { PortfolioChart } from "../../components/portfolio-chart";
import { type AllocDimension, buildAllocation } from "../../lib/allocation";
import { getPortfolioHistory } from "../../lib/server/history";
import { getMyOverview } from "../../lib/server/overview";

// 洞察:组合走势(复用 history)+ 分配饼图 + 维度切换(代币/链/账户)。读时算,复用 overview 的 holdings。
export const Route = createFileRoute("/_authed/insights")({
  loader: async () => {
    const [overview, history] = await Promise.all([getMyOverview(), getPortfolioHistory()]);
    return { holdings: overview.holdings, series: history.series };
  },
  component: Insights,
});

const DIMS = [
  { key: "token", label: "byToken" },
  { key: "chain", label: "byChain" },
  { key: "account", label: "byAccount" },
] as const;

function Insights() {
  const { holdings, series } = Route.useLoaderData();
  const t = useTranslations("Insights");
  const [dim, setDim] = useState<AllocDimension>("token");
  const slices = buildAllocation(holdings, dim);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("trend")}</CardTitle>
        </CardHeader>
        <CardContent>
          {series.length < 2 ? (
            <p className="text-muted-foreground text-sm">{t("noData")}</p>
          ) : (
            <PortfolioChart series={series} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("allocation")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Tabs value={dim} onValueChange={(v) => setDim(v as AllocDimension)}>
            <TabsListThin>
              {DIMS.map((d) => (
                <TabsTriggerThin key={d.key} value={d.key}>
                  {t(d.label)}
                </TabsTriggerThin>
              ))}
            </TabsListThin>
          </Tabs>
          <AllocationPie slices={slices} />
        </CardContent>
      </Card>
    </div>
  );
}
