import { Skeleton } from "@folio/ui";
import { useTranslations } from "use-intl";
import { QueryBoundary } from "@/components/query-boundary";
import { mergeDefiGroups } from "@/lib/core/account-view";
import { useHomeTabStrip } from "@/lib/hooks/use-home-tab-strip";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { type PinScopeKey, portfolioKeys } from "@/lib/queries/keys";
import type { PortfolioOverview } from "@/lib/queries/portfolio";
import { usePortfolioOverview } from "@/lib/queries/portfolio-overview-compose";
import { type KindTab, kindTabsOf, pinScopeOf } from "@/routes/_authed/-home/home-tabs";
import { useHomeTabSelection } from "@/routes/_authed/-home/tab/selection";
import { DefiPositions } from "./defi";
import { PerpPositionsList } from "./perp";
import { SectionList } from "./section-list";
import { TokenHoldings } from "./tokens";
import { GainSkeleton } from "./value-delta";

const ROWS_3 = ["r1", "r2", "r3"];

function ListSkeleton() {
  return (
    <div className="flex flex-col">
      {ROWS_3.map((k) => (
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

// Splits a data set's sections into perp items, DeFi groups and the perp equity subtotal. Pure:
// custom tabs split in their own subcomponent (PinContent), and the strip's total uses it too.
export function derive(secs: PortfolioOverview["sections"]) {
  const defiGroups = mergeDefiGroups(secs);
  const perpItems = secs.flatMap((s) =>
    s.perp && (s.perp.positions.length > 0 || s.perp.equity != null)
      ? [
          {
            id: s.account.id,
            view: s.perp,
            platform: s.account.platform,
            accountLabel: s.account.label,
          },
        ]
      : [],
  );
  const perpEquitySubtotal = perpItems.reduce(
    (sum, it) => sum + (it.view.equity?.accountValue ?? 0),
    0,
  );
  return { defiGroups, perpItems, perpEquitySubtotal };
}

// The overview was awaited by the outer boundary and 24h PnL rides on `overview.holdings[].gain24h`
// / `overview.sections`, so no suspense boundary here. Custom tabs (pins) use their own overview
// query and boundary.
export function HoldingsIsland() {
  const { selectedId } = usePortfolio();
  const tct = useTranslations("CustomTabs");
  const strip = useHomeTabStrip(selectedId);
  const { shownActive } = useHomeTabSelection(strip.pins);
  const portfolioData = usePortfolioOverview(selectedId);
  if (!strip.hasAccounts) return null;

  const activePin = strip.pins.find((p) => p.id === shownActive) ?? null;
  const isPinView = activePin != null;
  const pinScope = activePin ? pinScopeOf(activePin) : undefined;
  const pinBoundaryKey = pinScope
    ? JSON.stringify(portfolioKeys.overviewCompose(selectedId, pinScope))
    : "";
  const kindTabs = kindTabsOf(strip.hasPerps, strip.hasDefi);
  const activeKind: KindTab | null = isPinView
    ? null
    : kindTabs.includes(shownActive as KindTab)
      ? (shownActive as KindTab)
      : "tokens";

  if (isPinView && pinScope) {
    return (
      <QueryBoundary
        key={activePin.id}
        resetKey={pinBoundaryKey}
        pending={<ListSkeleton />}
        failed={
          <p className="py-12 text-center text-muted-foreground text-sm">{tct("actionFailed")}</p>
        }
      >
        <PinContent portfolioId={selectedId} pin={pinScope} />
      </QueryBoundary>
    );
  }
  return <KindBody overview={portfolioData} activeKind={activeKind} />;
}

// PnL is already on `overview.holdings` / `overview.sections`; read it directly.
function KindBody({
  overview,
  activeKind,
}: {
  overview: PortfolioOverview;
  activeKind: KindTab | null;
}) {
  const t = useTranslations("Overview");
  const kind = derive(overview.sections);
  if (activeKind === "perps") return <PerpPositionsList items={kind.perpItems} />;
  if (activeKind === "defi") {
    return <DefiPositions groups={kind.defiGroups} hideHeader />;
  }
  if (overview.holdings.length === 0) {
    return <p className="py-12 text-center text-muted-foreground text-sm">{t("noSnapshot")}</p>;
  }
  return <TokenHoldings holdings={overview.holdings} />;
}

function PinContent({ portfolioId, pin }: { portfolioId: string; pin: PinScopeKey }) {
  const tct = useTranslations("CustomTabs");
  const data = usePortfolioOverview(portfolioId, pin);
  if (data.holdings.length === 0 && data.sections.length === 0) {
    return <p className="py-12 text-center text-muted-foreground text-sm">{tct("empty")}</p>;
  }
  return <PinBody overview={data} />;
}

function PinBody({ overview }: { overview: PortfolioOverview }) {
  const t = useTranslations("Overview");
  const parts = derive(overview.sections);
  return (
    <SectionList
      sections={[
        {
          key: "tokens",
          title: t("tokensTab"),
          subtotal: overview.holdingsSubtotal,
          count: overview.holdings.length,
          content: <TokenHoldings holdings={overview.holdings} />,
        },
        {
          key: "perps",
          title: t("perpsTab"),
          subtotal: parts.perpEquitySubtotal,
          count: parts.perpItems.length,
          content: <PerpPositionsList items={parts.perpItems} />,
        },
        {
          key: "defi",
          title: t("defiTab"),
          subtotal: overview.defiSubtotal,
          count: parts.defiGroups.length,
          content: <DefiPositions groups={parts.defiGroups} hideHeader />,
        },
      ]}
    />
  );
}
