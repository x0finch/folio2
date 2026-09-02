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

// 持仓列表。**总览已经由外层边界等过**,而 24h 盈亏(FOL-51 起两端相减、随总览原料一起算好)
// 就挂在 `overview.holdings[].gain24h` / `overview.sections` 上 —— 不再是后到的一条,不需要自己的
// 挂起边界。自定义 Tab(pin)是另一份总览查询,仍走它的边界(等的是那份原料,不是盈亏)。
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

// 一份渲染:盈亏已挂在 `overview.holdings` / `overview.sections` 上,直接读。
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
