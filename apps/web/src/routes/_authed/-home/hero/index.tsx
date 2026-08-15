import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { usePortfolio } from "../../../../lib/hooks/use-portfolio";
import { useStalePriceRefresh } from "../../../../lib/hooks/use-stale-price-refresh";
import {
  portfolioGain24hQuery,
  portfolioHistoryQuery,
  portfolioOverviewQuery,
} from "../../../../lib/queries/portfolio";
import { attachHoldingGains } from "../holdings/attach-gains";
import { PortfolioHero } from "./portfolio-hero";

export function HeroIsland() {
  const { selectedId } = usePortfolio();
  const { data } = useSuspenseQuery(portfolioOverviewQuery(selectedId));
  // 曲线非挂起:没到不拖住 hero 的数字,区域走既有「还在取数」态。
  const historyQuery = useQuery(portfolioHistoryQuery(selectedId));
  // 盈亏非挂起:总净值先亮,增量 / best-worst 走小骨架。
  const gainQuery = useQuery(portfolioGain24hQuery(selectedId));
  useStalePriceRefresh(data.pricesStale, !gainQuery.isPending);
  const holdings = attachHoldingGains(data.holdings, gainQuery.data, gainQuery.isError);
  return (
    <PortfolioHero
      series={historyQuery.data?.series ?? []}
      loading={historyQuery.isPending}
      totalUsd={data.totalUsd}
      gain24h={gainQuery.isError ? null : (gainQuery.data?.portfolio ?? null)}
      gainPending={gainQuery.isPending}
      gainFailed={gainQuery.isError}
      holdings={holdings}
    />
  );
}
