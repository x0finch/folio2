import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { type HistoryPoint, toDailySeries } from "../../../lib/core/history";
import { usePortfolio } from "../../../lib/hooks/use-portfolio";
import { portfolioHistoryQuery, portfolioOverviewQuery } from "../../../lib/queries/portfolio";
import { HeaderSync } from "../-home/header-sync";
import { ALLOC_DIMENSIONS, type AllocDimension, buildAllocation } from "./allocation";
import { AllocationPie } from "./allocation-pie";
import { CHART_FRAME, PortfolioChart } from "./portfolio-chart";

const insightsRoute = getRouteApi("/_authed/insights");

// 失败一直再试:这页不展示失败句,骨架等到成功。只加在这两条上,不改全站默认。
const KEEP_TRYING = { retry: true as const };

const DIM_LABEL: Record<AllocDimension, string> = {
  token: "byToken",
  chain: "byChain",
  account: "byAccount",
};

export function Insights() {
  return (
    <div className="flex flex-col gap-6">
      <HeaderSync />
      <TrendCard />
      <AllocationCard />
    </div>
  );
}

function TrendCard() {
  const t = useTranslations("Insights");
  const { selectedId } = usePortfolio();
  const historyQuery = useQuery({ ...portfolioHistoryQuery(selectedId), ...KEEP_TRYING });
  const body =
    historyQuery.data == null ? (
      <Skeleton className={CHART_FRAME} />
    ) : (
      <TrendReady series={historyQuery.data.series} />
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("trend")}</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function TrendReady({ series }: { series: readonly HistoryPoint[] }) {
  const t = useTranslations("Insights");
  const trend = toDailySeries(series);
  if (trend.length < 2) {
    return <p className="text-muted-foreground text-sm">{t("noData")}</p>;
  }
  return <PortfolioChart series={trend} />;
}

function AllocationCard() {
  const t = useTranslations("Insights");
  const { selectedId } = usePortfolio();
  const { dim } = insightsRoute.useSearch();
  const navigate = insightsRoute.useNavigate();
  const overviewQuery = useQuery({ ...portfolioOverviewQuery(selectedId), ...KEEP_TRYING });
  const setDim = (v: AllocDimension) => {
    if (v === dim) return;
    navigate({
      search: (prev) => ({ ...prev, dim: v }),
      replace: true,
      resetScroll: false,
    });
  };
  const pie =
    overviewQuery.data == null ? (
      <Skeleton className={CHART_FRAME} />
    ) : (
      <AllocationPie slices={buildAllocation(overviewQuery.data.holdings, dim)} />
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("allocation")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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
      </CardContent>
    </Card>
  );
}
