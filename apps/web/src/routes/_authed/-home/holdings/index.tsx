import { Skeleton } from "@folio/ui";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { QueryBoundary } from "../../../../components/query-boundary";
import { mergeDefiGroups } from "../../../../lib/account-view";
import { usePortfolio } from "../../../../lib/hooks/use-portfolio";
import { type PinScopeKey, portfolioKeys } from "../../../../lib/queries/keys";
import {
  homeTabStripQuery,
  type PortfolioOverview,
  portfolioGain24hQuery,
  portfolioOverviewQuery,
} from "../../../../lib/queries/portfolio";
import { type KindTab, kindTabsOf, pinScopeOf } from "../home-tabs";
import { useHomeTabSelection } from "../tab/selection";
import { attachDefiGains, attachHoldingGains } from "./attach-gains";
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

// 现货/永续/DeFi 三段的拆解(从某份数据的 sections 里挑出永续项 + DeFi 分组 + 永续权益小计)。
// 纯函数 —— 自定义 Tab 的内容由子组件自己拉数据、自己拆(见 PinContent);tab 条右侧合计也用它。
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

export function HoldingsIsland() {
  const { selectedId } = usePortfolio();
  const t = useTranslations("Overview");
  const tct = useTranslations("CustomTabs");
  const { data: strip } = useSuspenseQuery(homeTabStripQuery(selectedId));
  const { shownActive } = useHomeTabSelection(strip.pins);
  const { data: portfolioData } = useSuspenseQuery(portfolioOverviewQuery(selectedId));
  const gainQuery = useQuery(portfolioGain24hQuery(selectedId));
  if (!strip.hasAccounts) return null;

  const activePin = strip.pins.find((p) => p.id === shownActive) ?? null;
  const isPinView = activePin != null;
  const pinScope = activePin ? pinScopeOf(activePin) : undefined;
  const pinBoundaryKey = pinScope
    ? JSON.stringify(portfolioKeys.overview(selectedId, pinScope))
    : "";
  const kindTabs = kindTabsOf(strip.hasPerps, strip.hasDefi);
  const activeKind: KindTab | null = isPinView
    ? null
    : kindTabs.includes(shownActive as KindTab)
      ? (shownActive as KindTab)
      : "tokens";
  const holdings = attachHoldingGains(portfolioData.holdings, gainQuery.data, gainQuery.isError);
  const kind = derive(attachDefiGains(portfolioData.sections, gainQuery.data, gainQuery.isError));

  return isPinView && pinScope ? (
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
  ) : activeKind === "perps" ? (
    <PerpPositionsList items={kind.perpItems} />
  ) : activeKind === "defi" ? (
    <DefiPositions groups={kind.defiGroups} hideHeader gainPending={gainQuery.isPending} />
  ) : holdings.length === 0 ? (
    <p className="py-12 text-center text-muted-foreground text-sm">{t("noSnapshot")}</p>
  ) : (
    <TokenHoldings holdings={holdings} gainPending={gainQuery.isPending} />
  );
}

function PinContent({ portfolioId, pin }: { portfolioId: string; pin: PinScopeKey }) {
  const t = useTranslations("Overview");
  const tct = useTranslations("CustomTabs");
  const { data } = useSuspenseQuery(portfolioOverviewQuery(portfolioId, pin));
  const gainQuery = useQuery(portfolioGain24hQuery(portfolioId, pin));
  const holdings = attachHoldingGains(data.holdings, gainQuery.data, gainQuery.isError);
  const parts = derive(attachDefiGains(data.sections, gainQuery.data, gainQuery.isError));

  if (data.holdings.length === 0 && parts.perpItems.length === 0 && parts.defiGroups.length === 0) {
    return <p className="py-12 text-center text-muted-foreground text-sm">{tct("empty")}</p>;
  }
  return (
    <SectionList
      sections={[
        {
          key: "tokens",
          title: t("tokensTab"),
          subtotal: data.holdingsSubtotal,
          count: data.holdings.length,
          content: <TokenHoldings holdings={holdings} gainPending={gainQuery.isPending} />,
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
          subtotal: data.defiSubtotal,
          count: parts.defiGroups.length,
          content: (
            <DefiPositions groups={parts.defiGroups} hideHeader gainPending={gainQuery.isPending} />
          ),
        },
      ]}
    />
  );
}
