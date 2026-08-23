import { useSuspenseQuery } from "@tanstack/react-query";
import { QueryBoundary } from "@/components/query-boundary";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { useStalePriceRefresh } from "@/lib/hooks/use-stale-price-refresh";
import { portfolioKeys } from "@/lib/queries/keys";
import {
  type PortfolioOverview,
  portfolioGain24hQuery,
  portfolioHistoryQuery,
  portfolioOverviewQuery,
} from "@/lib/queries/portfolio";
import { attachHoldingGains } from "@/routes/_authed/-home/holdings/attach-gains";
import { PortfolioHero } from "./portfolio-hero";

// hero 的两截:**总净值**来自总览(外层边界已经等过它),**曲线 + 24h 盈亏**是后到的两样。
//
// 后两样走**挂起 + 自己的边界**,不是 `useQuery` + `isPending` 判骨架(#488 原来的写法)。
// 后者在 SSR 上是错的:loader 把这两条发出去就返回,等总览回来时它们通常也回来了 ——
// **服务端渲染那一遍有数据**;而客户端**补水那一帧**读的脱水缓存里还没有它们 —— **没数据**。
// 一边画值、一边画骨架,React 把整棵子树丢掉重渲(首屏一条 hydration mismatch)。
//
// 挂起 + 边界让两边一致:服务端把真实的数字渲进 HTML,边界那段随流补上,客户端在**同一个
// 边界处**等。**首屏 HTML 里那些数字留着** —— 这是它比「让服务端也画骨架」强的地方:
// 后者两边确实一致了,代价是 JS 跑起来之前那一段用户看到的是骨架。
//
// **曲线与盈亏共用一个边界,是有意合的。** 分开要给 `PortfolioHero` 写四份不同 flag 的调用
// (挂起×2 / 失败×2 的组合),而它有七个参数;两条查询同源同一次请求,一起到、一起塌是可接受
// 的近似。代价写在这儿:曲线拉失败时,盈亏那格也会显示失败提示,尽管盈亏本身没问题。
export function HeroIsland() {
  const { selectedId } = usePortfolio();
  const { data } = useSuspenseQuery(portfolioOverviewQuery(selectedId));
  const extrasKey = JSON.stringify([
    portfolioKeys.history(selectedId),
    portfolioKeys.gain24h(selectedId),
  ]);
  return (
    <QueryBoundary
      resetKey={`hero-extras:${extrasKey}`}
      // 还在取:总净值照常渲染(它已经有了),曲线与增量走各自的「还在取数」态。
      pending={<HeroShell overview={data} loading gainPending />}
      // 塌了:总净值仍然在,增量那格显示破折号 + 一处失败提示。
      failed={<HeroShell overview={data} gainFailed />}
    >
      <HeroReady overview={data} portfolioId={selectedId} />
    </QueryBoundary>
  );
}

// 三种状态共用的那一次调用 —— 差别只在几个 flag 与两样后到的数据上。
// 抄四遍七个参数是这个文件上一版最容易腐烂的地方。
function HeroShell({
  overview,
  series = [],
  gain24h = null,
  loading = false,
  gainPending = false,
  gainFailed = false,
}: {
  overview: PortfolioOverview;
  series?: React.ComponentProps<typeof PortfolioHero>["series"];
  gain24h?: React.ComponentProps<typeof PortfolioHero>["gain24h"];
  loading?: boolean;
  gainPending?: boolean;
  gainFailed?: boolean;
}) {
  // 增量没到 / 塌了的时候,持仓行照旧渲染,只是它们的 delta 位由 `gainPending` 决定显示什么。
  const holdings = attachHoldingGains(overview.holdings, undefined, gainFailed);
  return (
    <PortfolioHero
      series={series}
      loading={loading}
      totalUsd={overview.totalUsd}
      gain24h={gain24h}
      gainPending={gainPending}
      gainFailed={gainFailed}
      holdings={holdings}
    />
  );
}

// 挂起点在这儿:两条查询都到了才渲染。
function HeroReady({
  overview,
  portfolioId,
}: {
  overview: PortfolioOverview;
  portfolioId: string;
}) {
  const history = useSuspenseQuery(portfolioHistoryQuery(portfolioId));
  const gain = useSuspenseQuery(portfolioGain24hQuery(portfolioId));
  // 只在盈亏真的到了之后才允许触发刷价 —— 与上一版 `!gainQuery.isPending` 同一个条件,
  // 只是现在「到了」由挂起保证,不必再问。
  useStalePriceRefresh(overview.pricesStale, true);
  return (
    <PortfolioHero
      series={history.data.series}
      totalUsd={overview.totalUsd}
      gain24h={gain.data.portfolio ?? null}
      holdings={attachHoldingGains(overview.holdings, gain.data, false)}
    />
  );
}
