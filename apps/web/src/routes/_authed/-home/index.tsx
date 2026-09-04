import { Skeleton } from "@folio/ui";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { QueryBoundary } from "@/components/query-boundary";
import { floorToHour } from "@/lib/core/portfolio";
import { useHomeTabStrip } from "@/lib/hooks/use-home-tab-strip";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { portfolioKeys } from "@/lib/queries/keys";
import { HeaderSync } from "./header-sync";
import { HeroIsland } from "./hero";
import { HoldingsIsland } from "./holdings";
import { GainSkeleton } from "./holdings/value-delta";
import { TabStripIsland } from "./tab";
import { HomeViewStateProvider } from "./view-state";

export function Overview() {
  const { selectedId } = usePortfolio();
  const now = floorToHour(Date.now());
  // 两岛共用原子快照这份数据,所以会一起亮;失败则只塌那一格,壳(HeaderSync)不受影响。
  const snapshotsKey = JSON.stringify(portfolioKeys.snapshots(selectedId, now));
  const tabsKey = JSON.stringify(portfolioKeys.tabPins(selectedId));
  return (
    // 主 tab 与代币抽屉的页内状态住这层 Provider(FOL-80):tab 条与两个 TokenHoldings 实例共读一份。
    <HomeViewStateProvider>
      <div className="flex flex-col gap-6">
        <HeaderSync />
        <QueryBoundary
          resetKey={`hero:${snapshotsKey}`}
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
            resetKey={`holdings:${snapshotsKey}`}
            pending={<HoldingsSkeleton />}
            failed={<IslandFailed />}
          >
            <HoldingsIsland />
          </QueryBoundary>
        </div>
      </div>
    </HomeViewStateProvider>
  );
}

// 没账户是这一页下半截的空态,不是 tab 条自己的事 —— 条只在有账户时才挂。
function TabStripSlot() {
  const { selectedId } = usePortfolio();
  const strip = useHomeTabStrip(selectedId);
  const tc = useTranslations("Common");
  if (!strip.hasAccounts) {
    return (
      <p className="text-muted-foreground">
        {tc("noAccountsYet")}{" "}
        <Link to="/{-$page}" params={{ page: "accounts" }} className="underline">
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

function HeroSkeleton() {
  // 与 PortfolioHero 外框 `min-h-60` 同高,tab 条不会在数字到位时被顶下去。
  return <Skeleton className="min-h-60 w-full" />;
}

function TabStripSkeleton() {
  return (
    <div className="flex items-center gap-4">
      <Skeleton className="h-8 w-64 rounded-full" />
      <Skeleton className="inline-block h-4 w-24 rounded-full" />
    </div>
  );
}

const ROWS_5 = ["r1", "r2", "r3", "r4", "r5"];

function HoldingsSkeleton() {
  return (
    <div className="flex flex-col">
      {ROWS_5.map((k) => (
        <div key={k} className="flex items-center gap-3 px-3 py-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Skeleton className="h-4 w-20" />
            <GainSkeleton />
          </div>
        </div>
      ))}
    </div>
  );
}
