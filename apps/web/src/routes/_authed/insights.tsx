import { Card, CardContent, CardHeader, CardTitle, Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { AllocationPie } from "../../components/allocation-pie";
import { HeaderSync } from "../../components/header-sync";
import { PortfolioChart } from "../../components/portfolio-chart";
import { InsightsSkeleton } from "../../components/skeletons";
import { type AllocDimension, buildAllocation } from "../../lib/allocation";
import { toDailySeries } from "../../lib/history";
import { useHoldHeight } from "../../lib/hooks/use-hold-height";
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
  // **回落就在这一层做完**,所以返回类型是 `AllocDimension` 而不是 `string` —— 组件那侧从此拿到的
  // 一定是三个合法维度之一,不必再 clamp 一遍。
  //
  // 之前这里写的是「validateSearch 只收窄类型、不过滤值」,并据此把回落放到了组件里。**现象是真的,
  // 归因是错的**:router 把验证结果**合并**进 search 而不是替换掉它 ——
  // `preMatchSearch = { ...parentSearch, ...strictSearch }`(router-core 的 matchRoutes)。返回 `{}`
  // 等于一个键都不覆盖,`?dim=bogus` 当然原样留着。让它**显式返回 `dim`**,脏值就在这里被盖掉。
  validateSearch: (search: Record<string, unknown>): { dim: AllocDimension } => ({
    dim: isDimension(search.dim) ? search.dim : DEFAULT_DIM,
  }),
  // 默认维度不写进 URL:`/insights` 就是 token。以前是在每个导航调用点手写
  // `v === DEFAULT_DIM ? undefined : v`,现在交给官方中间件 —— 它在 buildLocation 时统一剥,
  // 漏写一个调用点就多一份冗余参数的可能性没有了。
  search: { middlewares: [stripSearchParams({ dim: DEFAULT_DIM })] },
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
  // 认不出的值已在 route 的 `validateSearch` 里回落掉了,这里拿到的必是合法维度。
  const { dim } = Route.useSearch();
  const navigate = Route.useNavigate();
  // `resetScroll: false`:换维度不该动滚动位置。scrollRestoration 认的是地址,`?dim=` 一变就是新地址、
  // 没有记录 → 归零,观感等于整页刷新一下(首页那处同理,有更细的说明)。
  // `useHoldHeight` 管的是另一半:换内容那一下高度塌了、滚动位置被浏览器夹掉(与导航无关)。
  const { ref: contentRef, hold } = useHoldHeight(dim);
  const setDim = (v: AllocDimension) => {
    if (v === dim) return;
    hold();
    // 默认维度不必在这里抹成 undefined —— `stripSearchParams` 中间件在建地址时统一剥掉。
    navigate({
      search: (prev) => ({ ...prev, dim: v }),
      replace: true,
      resetScroll: false,
    });
  };
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
        {/* ref 落在「维度 tab + 饼图」这块:换维度时塌的就是它(图例条目数不同 → 高度不同)。 */}
        <CardContent ref={contentRef} className="flex flex-col gap-4">
          <Tabs value={dim} onValueChange={(v) => setDim(v as AllocDimension)} variant="underline">
            <TabsList>
              {ALLOC_DIMENSIONS.map((d) => (
                <TabsTrigger key={d} value={d}>
                  {t(DIM_LABEL[d])}
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
