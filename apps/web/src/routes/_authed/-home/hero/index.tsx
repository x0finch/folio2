import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { QueryBoundary } from "@/components/query-boundary";
import { toPortfolioCurve } from "@/lib/core/history";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { useStalePriceRefresh } from "@/lib/hooks/use-stale-price-refresh";
import { portfolioKeys } from "@/lib/queries/keys";
import {
  type PortfolioOverview,
  portfolioHistoryQuery,
  portfolioOverviewQuery,
} from "@/lib/queries/portfolio";
import { PortfolioHero } from "./portfolio-hero";

// hero 的两截:**总净值 + 24h 盈亏**来自总览(外层边界已经等过它;盈亏 FOL-51 起随总览原料两端
// 相减算好,不再是后到的一条),**曲线**是唯一后到的那样。
//
// 曲线走**挂起 + 自己的边界**,不是 `useQuery` + `isPending` 判骨架(#488 原来的写法)。
// 后者在 SSR 上是错的:loader 把它发出去就返回,等总览回来时它通常也回来了 —— **服务端渲染那一遍
// 有数据**;而客户端**补水那一帧**读的脱水缓存里还没有它 —— **没数据**。一边画值、一边画骨架,
// React 把整棵子树丢掉重渲(首屏一条 hydration mismatch)。挂起 + 边界让两边一致。
export function HeroIsland() {
  const { selectedId } = usePortfolio();
  const { data } = useSuspenseQuery(portfolioOverviewQuery(selectedId));
  // 首次同步中(有账户、还没有任何快照):别把「还不知道」画成 $0 —— 整块 hero 走加载态。
  // 总览查询会短轮询,拿到第一张快照后 `pending` 转 false,这里自动换成真数据。曲线此刻也无从
  // 谈起,一并走加载占位,不必再进下面那个后到数据的边界。
  if (data.pending) return <HeroShell overview={data} loading syncing />;
  return (
    <QueryBoundary
      resetKey={`hero-curve:${JSON.stringify(portfolioKeys.history(selectedId, "30d"))}`}
      // 还在取:总净值 / 盈亏照常渲染(它们已经有了),曲线走「还在取数」态。
      pending={<HeroShell overview={data} loading />}
      // 塌了:总净值 / 盈亏仍然在,曲线区退成空(不整块塌)。
      failed={<HeroShell overview={data} />}
    >
      <HeroReady overview={data} portfolioId={selectedId} />
    </QueryBoundary>
  );
}

// 三种状态共用的那一次调用 —— 差别只在 loading 与后到的曲线上。24h 盈亏恒取自总览,不再有
// 「盈亏还没到」的态。
function HeroShell({
  overview,
  series = [],
  loading = false,
  syncing = false,
}: {
  overview: PortfolioOverview;
  series?: React.ComponentProps<typeof PortfolioHero>["series"];
  loading?: boolean;
  syncing?: boolean;
}) {
  return (
    <PortfolioHero
      series={series}
      loading={loading}
      totalUsd={overview.totalUsd}
      gain24h={overview.gain24h ?? null}
      syncing={syncing}
      holdings={overview.holdings}
    />
  );
}

// 挂起点在这儿:曲线到了才渲染。
function HeroReady({
  overview,
  portfolioId,
}: {
  overview: PortfolioOverview;
  portfolioId: string;
}) {
  const history = useSuspenseQuery(portfolioHistoryQuery(portfolioId, "30d"));
  // 曲线在浏览器里算(FOL-38):接口发的是原样的快照点。**末点用总览按账户那张表加出来** ——
  // 屏幕上那个大数字与曲线最右端必须是同一个数,而它已经算过一遍了,不该为曲线再算一次。
  // 记忆化不是为了这一次:hero 里划动读数会一路重渲,重建曲线不该跟着每帧跑一遍。
  const series = useMemo(() => toPortfolioCurve(history.data, overview), [history.data, overview]);
  useStalePriceRefresh(overview.pricesStale, true);
  return (
    <PortfolioHero
      series={series}
      totalUsd={overview.totalUsd}
      gain24h={overview.gain24h ?? null}
      holdings={overview.holdings}
    />
  );
}
