import { useTranslations } from "use-intl";
import { HeaderSync } from "../../../components/header-sync";
import { QueryBoundary } from "../../../components/query-boundary";
import { HeroSkeleton, HoldingsSkeleton, TabStripSkeleton } from "../../../components/skeletons";
import { usePortfolio } from "../../../lib/hooks/use-portfolio";
import { portfolioKeys } from "../../../lib/queries/keys";
import { HeroIsland } from "./hero";
import { HoldingsIsland } from "./holdings";
import { TabStripIsland } from "./tab-strip";

export function Overview() {
  const { selectedId } = usePortfolio();
  // 两岛共用总览这份数据,所以会一起亮;失败则只塌那一格,壳(HeaderSync)不受影响。
  const overviewKey = JSON.stringify(portfolioKeys.overview(selectedId));
  const tabsKey = JSON.stringify(portfolioKeys.tabStrip(selectedId));
  return (
    <div className="flex flex-col gap-6">
      <HeaderSync />
      <QueryBoundary
        resetKey={`hero:${overviewKey}`}
        pending={<HeroSkeleton />}
        failed={<IslandFailed />}
      >
        <HeroIsland />
      </QueryBoundary>
      <div className="flex flex-col gap-4">
        <QueryBoundary
          resetKey={`tabs:${tabsKey}`}
          pending={<TabStripSkeleton />}
          failed={<IslandFailed />}
        >
          <TabStripIsland />
        </QueryBoundary>
        <QueryBoundary
          resetKey={`holdings:${overviewKey}`}
          pending={<HoldingsSkeleton />}
          failed={<IslandFailed />}
        >
          <HoldingsIsland />
        </QueryBoundary>
      </div>
    </div>
  );
}

function IslandFailed() {
  const t = useTranslations("Overview");
  return <p className="py-12 text-center text-muted-foreground text-sm">{t("loadFailed")}</p>;
}
