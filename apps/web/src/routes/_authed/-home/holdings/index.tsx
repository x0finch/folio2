import { Skeleton } from "@folio/ui";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { QueryBoundary } from "@/components/query-boundary";
import { mergeDefiGroups } from "@/lib/core/account-view";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { type PinScopeKey, portfolioKeys } from "@/lib/queries/keys";
import {
  homeTabStripQuery,
  type PortfolioOverview,
  portfolioGain24hQuery,
  portfolioOverviewQuery,
} from "@/lib/queries/portfolio";
import { type KindTab, kindTabsOf, pinScopeOf } from "@/routes/_authed/-home/home-tabs";
import { useHomeTabSelection } from "@/routes/_authed/-home/tab/selection";
import { attachDefiGains, attachHoldingGains, type GainMaps } from "./attach-gains";
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

// 持仓列表。**总览已经由外层边界等过**;后到的是 24h 盈亏,它只决定每行 delta 那一格。
//
// 盈亏走**挂起 + 自己的边界**,不是 `useQuery` + `isPending`(#488 原来的写法)。理由见
// `../hero/index.tsx` 开头那段:那种写法在 SSR 上服务端有数据、客户端补水那一帧没有,
// 两边画的不是同一份 HTML,React 把整棵子树丢掉重渲。
//
// 这里的边界有个好处:**`pending` 的兜底就是「同一个列表,delta 位是骨架」** —— 也就是上一版
// 挂起态逐字渲的东西。所以粒度一点没丢:市值那一列照旧立刻出现,只有增量在等。
export function HoldingsIsland() {
  const { selectedId } = usePortfolio();
  const tct = useTranslations("CustomTabs");
  const { data: strip } = useSuspenseQuery(homeTabStripQuery(selectedId));
  const { shownActive } = useHomeTabSelection(strip.pins);
  const { data: portfolioData } = useSuspenseQuery(portfolioOverviewQuery(selectedId));
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
  return (
    <QueryBoundary
      resetKey={`holdings-gain:${JSON.stringify(portfolioKeys.gain24h(selectedId))}`}
      pending={<KindBody overview={portfolioData} activeKind={activeKind} gainPending />}
      failed={<KindBody overview={portfolioData} activeKind={activeKind} gainFailed />}
    >
      <KindReady overview={portfolioData} portfolioId={selectedId} activeKind={activeKind} />
    </QueryBoundary>
  );
}

// 三种状态共用的那一份渲染:`gain` 有就用真值,没有就按 `gainPending` / `gainFailed` 走占位。
function KindBody({
  overview,
  activeKind,
  gain,
  gainPending = false,
  gainFailed = false,
}: {
  overview: PortfolioOverview;
  activeKind: KindTab | null;
  gain?: GainMaps;
  gainPending?: boolean;
  gainFailed?: boolean;
}) {
  const t = useTranslations("Overview");
  const holdings = attachHoldingGains(overview.holdings, gain, gainFailed);
  const kind = derive(attachDefiGains(overview.sections, gain, gainFailed));
  if (activeKind === "perps") return <PerpPositionsList items={kind.perpItems} />;
  if (activeKind === "defi") {
    return <DefiPositions groups={kind.defiGroups} hideHeader gainPending={gainPending} />;
  }
  if (holdings.length === 0) {
    return <p className="py-12 text-center text-muted-foreground text-sm">{t("noSnapshot")}</p>;
  }
  return <TokenHoldings holdings={holdings} gainPending={gainPending} />;
}

// 挂起点在这儿。
function KindReady({
  overview,
  portfolioId,
  activeKind,
}: {
  overview: PortfolioOverview;
  portfolioId: string;
  activeKind: KindTab | null;
}) {
  const { data } = useSuspenseQuery(portfolioGain24hQuery(portfolioId));
  return <KindBody overview={overview} activeKind={activeKind} gain={data} />;
}

function PinContent({ portfolioId, pin }: { portfolioId: string; pin: PinScopeKey }) {
  const tct = useTranslations("CustomTabs");
  const { data } = useSuspenseQuery(portfolioOverviewQuery(portfolioId, pin));
  if (data.holdings.length === 0 && data.sections.length === 0) {
    return <p className="py-12 text-center text-muted-foreground text-sm">{tct("empty")}</p>;
  }
  return (
    <QueryBoundary
      resetKey={`pin-gain:${JSON.stringify(portfolioKeys.gain24h(portfolioId, pin))}`}
      pending={<PinBody overview={data} gainPending />}
      failed={<PinBody overview={data} gainFailed />}
    >
      <PinReady overview={data} portfolioId={portfolioId} pin={pin} />
    </QueryBoundary>
  );
}

function PinBody({
  overview,
  gain,
  gainPending = false,
  gainFailed = false,
}: {
  overview: PortfolioOverview;
  gain?: GainMaps;
  gainPending?: boolean;
  gainFailed?: boolean;
}) {
  const t = useTranslations("Overview");
  const holdings = attachHoldingGains(overview.holdings, gain, gainFailed);
  const parts = derive(attachDefiGains(overview.sections, gain, gainFailed));
  return (
    <SectionList
      sections={[
        {
          key: "tokens",
          title: t("tokensTab"),
          subtotal: overview.holdingsSubtotal,
          count: overview.holdings.length,
          content: <TokenHoldings holdings={holdings} gainPending={gainPending} />,
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
          content: <DefiPositions groups={parts.defiGroups} hideHeader gainPending={gainPending} />,
        },
      ]}
    />
  );
}

// 挂起点在这儿。
function PinReady({
  overview,
  portfolioId,
  pin,
}: {
  overview: PortfolioOverview;
  portfolioId: string;
  pin: PinScopeKey;
}) {
  const { data } = useSuspenseQuery(portfolioGain24hQuery(portfolioId, pin));
  return <PinBody overview={overview} gain={data} />;
}
