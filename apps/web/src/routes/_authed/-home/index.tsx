import { Skeleton } from "@folio/ui";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { StaggerReveal } from "@/components/page-switcher/stagger-reveal";
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
  // Both islands share the atomic snapshot so they light up together; a failure collapses only its own slot.
  const snapshotsKey = JSON.stringify(portfolioKeys.snapshots(selectedId, now));
  const tabsKey = JSON.stringify(portfolioKeys.tabPins(selectedId));
  return (
    // Tab and token-drawer state live in this Provider: the tab strip and both TokenHoldings read one copy.
    <HomeViewStateProvider>
      {/* HeaderSync stays outside the entrance container: it is absolute against `<main>` and a
          transformed wrapper would shift it (see StaggerReveal). Opt-in auto-sync when data is stale. */}
      <HeaderSync autoSyncWhenStale />
      <StaggerReveal className="flex flex-col gap-6">
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
      </StaggerReveal>
    </HomeViewStateProvider>
  );
}

// The empty state is the lower half of the page, not the tab strip's concern; the strip mounts only with accounts.
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
  // Same height as PortfolioHero's `min-h-60` so the tab strip isn't pushed down when numbers arrive.
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
