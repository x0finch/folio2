import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { HeaderSync } from "../../../components/header-sync";
import { QueryBoundary } from "../../../components/query-boundary";
import { usePortfolio } from "../../../lib/hooks/use-portfolio";
import { portfolioKeys } from "../../../lib/queries/keys";
import { homeTabStripQuery } from "../../../lib/queries/portfolio";
import { HeroIsland } from "./hero";
import { HoldingsIsland } from "./holdings";
import { HeroSkeleton, HoldingsSkeleton, TabStripSkeleton } from "./skeletons";
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
          <TabStripSlot />
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

// 没账户是这一页下半截的空态,不是 tab 条自己的事 —— 条只在有账户时才挂。
function TabStripSlot() {
  const { selectedId } = usePortfolio();
  const { data: strip } = useSuspenseQuery(homeTabStripQuery(selectedId));
  const tc = useTranslations("Common");
  if (!strip.hasAccounts) {
    return (
      <p className="text-muted-foreground">
        {tc("noAccountsYet")}{" "}
        <Link to="/accounts" className="underline">
          {tc("addOne")}
        </Link>
        .
      </p>
    );
  }
  return <TabStripIsland />;
}

function IslandFailed() {
  const t = useTranslations("Overview");
  return <p className="py-12 text-center text-muted-foreground text-sm">{t("loadFailed")}</p>;
}
