import { Card, CardContent, CardHeader, CardTitle, Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { AllocationPie } from "../../components/allocation-pie";
import { HeaderSync } from "../../components/header-sync";
import { PortfolioChart } from "../../components/portfolio-chart";
import { InsightsSkeleton } from "../../components/skeletons";
import { TabPanel } from "../../components/tab-panel";
import { type AllocDimension, buildAllocation } from "../../lib/allocation";
import { toDailySeries } from "../../lib/history";
import { usePortfolio } from "../../lib/hooks/use-portfolio";
import { ALLOC_DIMENSIONS, DEFAULT_DIM, isDimension } from "../../lib/page-tabs";
import {
  portfolioHistoryQuery,
  portfolioListQuery,
  portfolioOverviewQuery,
} from "../../lib/queries/portfolio";

// 维度的标签。键的全集在 `lib/page-tabs`(那边还管回落判据),这里只配文案 ——
// `Record` 少配一个维度编译期就报,不会出现「新维度悄悄没标签」。
const DIM_LABEL: Record<AllocDimension, string> = {
  token: "byToken",
  chain: "byChain",
  account: "byAccount",
};

// 洞察:组合走势(复用 history)+ 分配饼图 + 维度切换(代币/链/账户)。读时算,复用 overview 的 holdings。
export const Route = createFileRoute("/_authed/insights")({
  // 分布维度进 URL(ADR 0043):刷新还停在原维度、链接能分享。
  //
  // **这里只声明形状,不声明「一定是三个合法维度之一」** —— 实测(`@tanstack/react-router@1.170.16`):
  // `validateSearch` 收窄的是**类型**,不过滤**值**。让它对 `?dim=bogus` 返回 `{}`,`useSearch()`
  // 照样给回 `dim: "bogus"`(验证器确实跑了,日志确认过)。所以写成 `dim?: AllocDimension` 是**类型撒谎**:
  // 编译期保证的东西运行期不成立。真正的回落放在组件里(和首页那套 clamp 同一个位置)。
  validateSearch: (search: Record<string, unknown>): { dim?: string } => {
    const dim = search.dim;
    return typeof dim === "string" && dim.length > 0 ? { dim } : {};
  },
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

function Insights() {
  const { selectedId } = usePortfolio();
  // 默认与非默认走同一个查询工厂,只是 portfolioId 不同 —— 以前是「默认走 loader、非默认走另一个
  // useQuery」,两边 key 不同族,整页刷新碰不到后者(停在非默认组合上写完画面不动)。
  const { data: overview } = useSuspenseQuery(portfolioOverviewQuery(selectedId));
  const { data: history } = useSuspenseQuery(portfolioHistoryQuery(selectedId));
  const t = useTranslations("Insights");
  // 维度住在 URL 里(ADR 0043);`replace` —— tab 切换不进后退栈,否则返回键变成倒放点击史。
  const { dim: dimParam } = Route.useSearch();
  const navigate = Route.useNavigate();
  // 认不出的值(手写乱码、将来删掉的维度)回落默认维度 —— 回落**必须在这里**,见 Route 上那段。
  const dim = isDimension(dimParam) ? dimParam : DEFAULT_DIM;
  const setDim = (v: AllocDimension) =>
    navigate({
      search: (prev) => ({ ...prev, dim: v === DEFAULT_DIM ? undefined : v }),
      replace: true,
    });
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
              {ALLOC_DIMENSIONS.map((d) => (
                <TabsTrigger key={d} value={d}>
                  {t(DIM_LABEL[d])}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {/* 维度切换的转场只包饼图(片6):tab 条自己不参与,卡片高度也不跟着抖。 */}
          <TabPanel tabKey={dim}>
            <AllocationPie slices={slices} />
          </TabPanel>
        </CardContent>
      </Card>
    </div>
  );
}
