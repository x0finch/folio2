import { Card, CardContent, CardHeader, CardTitle, Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { AllocationPie } from "../../components/allocation-pie";
import { HeaderSync } from "../../components/header-sync";
import { PortfolioChart } from "../../components/portfolio-chart";
import { InsightsSkeleton } from "../../components/skeletons";
import {
  ALLOC_DIMENSION,
  ALLOC_DIMENSIONS,
  type AllocDimension,
  buildAllocation,
  DEFAULT_DIM,
} from "../../lib/allocation";
import { toDailySeries } from "../../lib/history";
import { usePortfolio } from "../../lib/hooks/use-portfolio";
import {
  portfolioHistoryQuery,
  portfolioListQuery,
  portfolioOverviewQuery,
} from "../../lib/queries/portfolio";

// 维度的标签。键的全集在 `lib/allocation.ts`(那份 schema 既是合法值也是回落判据),这里只配文案 ——
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
  // 校验器就是维度那份 zod schema 本身(`lib/allocation.ts`,zod v4 = Standard Schema,Router
  // 直接吃,不用 adapter)。`.catch(DEFAULT_DIM)` 把「认不出的值」和「没带这个参数」一并收成默认维度,
  // 于是组件那侧拿到的**一定**是三个合法维度之一,不必再 clamp 一遍。
  //
  // 这里**必须显式产出 `dim`**,不能像早先那样对非法值返回 `{}`:router 把验证结果**合并**进
  // 已有的 search(`preMatchSearch = { ...parentSearch, ...strictSearch }`),没被覆盖的键原样留着,
  // `?dim=bogus` 就那么漏进了组件。
  validateSearch: z.object({ dim: ALLOC_DIMENSION.catch(DEFAULT_DIM) }),
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
  //
  // 换内容那一下**高度还是会塌**、滚动位置被浏览器夹掉 —— 那是另一件事(main 上就有,与本页
  // tab 进不进 URL 无关),成因是「panel 被卸载 + 所有 tab 共用一个滚动区」,治法见 #483。
  const setDim = (v: AllocDimension) => {
    if (v === dim) return;
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
          <AllocationPie slices={slices} />
        </CardContent>
      </Card>
    </div>
  );
}
