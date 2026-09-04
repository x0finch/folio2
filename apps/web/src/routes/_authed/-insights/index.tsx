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
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslations } from "use-intl";
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
import { CHART_FRAME, PortfolioChart } from "./portfolio-chart";

// 失败一直再试:这页不展示失败句,骨架等到成功。只加在这两条上,不改全站默认。
// 边界的 `failed` 因此基本到不了 —— 留着是因为渲染异常也会落进那个边界(见 query-boundary)。
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
  // **挂起式 + 自己的边界**,不是 `useQuery` + `data == null` 判骨架。后者在 SSR 上是错的:
  // 服务端渲染那一遍这条查询往往已经回来了(loader 发出去不 await),而客户端**补水那一帧**
  // 读的脱水缓存里还没有它 —— 一边画图、一边画骨架,React 把整棵子树丢掉重渲。
  // 挂起 + 边界让两边一致:服务端把图渲进 HTML、边界那段随流补上,客户端在同一个边界处等,
  // 首屏 HTML 里那张图**留着**(这是它比「服务端也画骨架」强的地方)。
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
    <Card>
      <CardHeader>
        <CardTitle>{t("trend")}</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

// 挂起点就在这儿:数据没到 → 上面那个边界显示骨架;到了 → 这里渲图。
function TrendReady({ portfolioId }: { portfolioId: string }) {
  const t = useTranslations("Insights");
  const { data } = useSuspenseQuery({
    ...portfolioHistoryQuery(portfolioId, "all"),
    ...KEEP_TRYING,
  });
  // 曲线在浏览器里算(FOL-38):接口发的是原样的快照点。末点要换成总览按账户那张表加出来的数
  // —— 与首页那个大数字同源,所以这里也要总览(FOL-57:原子 query 在浏览器合并)。
  // 记忆化的理由与 hero 那处相同:这棵子树会因别的状态重渲,重建曲线不该跟着跑。
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

// 同 TrendReady:挂起点在这儿。
function AllocationReady({ portfolioId, dim }: { portfolioId: string; dim: AllocDimension }) {
  const overview = usePortfolioOverview(portfolioId);
  return <AllocationPie slices={buildAllocation(overview.holdings, dim)} />;
}

function AllocationCard() {
  const t = useTranslations("Insights");
  const { selectedId } = usePortfolio();
  const now = floorToHour(Date.now());
  // 分布维度住组件内部 state(FOL-80,反转 ADR 0043):只 AllocationCard 一个组件用,`useState` 即可,
  // 不进 URL、不必 context。切维度只是 setState —— 不进后退栈、不动滚动,原来那套 replace/resetScroll
  // 要防的事天然不发生。切了组合后维度保留(与组合无关),是想要的。
  const [dim, setDim] = useState<AllocDimension>(DEFAULT_DIM);
  // 同 TrendCard:挂起 + 自己的边界(理由见那边)。
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
