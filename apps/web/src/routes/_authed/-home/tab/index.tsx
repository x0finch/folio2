import { Skeleton, Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import { QueryBoundary } from "@/components/query-boundary";
import { Sensitive } from "@/components/sensitive";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { useHomeTabStrip } from "@/lib/hooks/use-home-tab-strip";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { type PinScopeKey, portfolioKeys } from "@/lib/queries/keys";
import { usePortfolioOverview } from "@/lib/queries/portfolio-overview-compose";
import { derive } from "@/routes/_authed/-home/holdings";
import { type KindTab, kindTabsOf, pinScopeOf } from "@/routes/_authed/-home/home-tabs";
import { AddPinButton, PinTab } from "./pin";
import { revealTab, useHomeTabSelection } from "./selection";

function TabTotalSkeleton() {
  return <Skeleton className="inline-block h-4 w-24 rounded-full" />;
}

export function TabStripIsland() {
  const t = useTranslations("Overview");
  const { selectedId } = usePortfolio();
  const strip = useHomeTabStrip(selectedId);
  const { pins } = strip;
  const { selectTab, shownActive } = useHomeTabSelection(pins);
  const kindTabs = kindTabsOf(strip.hasPerps, strip.hasDefi);
  const isPinView = pins.some((p) => p.id === shownActive);
  const activeKind: KindTab = kindTabs.includes(shownActive as KindTab)
    ? (shownActive as KindTab)
    : "tokens";
  const activeValue = isPinView ? shownActive : activeKind;

  // Mobile strip scrolls horizontally: a selected tab that is off-screen is scrolled into view with
  // margin. Hand-rolled (see revealTab); a ResizeObserver re-corrects when the total's width
  // change narrows the strip and clips the tab again. The selected trigger holds its own ref.
  const stripRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLSpanElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeValue only signals when to scroll (the ref already moved to the new trigger); the callback reads the ref
  useLayoutEffect(() => {
    const elStrip = stripRef.current;
    if (!elStrip) return;
    const reveal = () => {
      const el = selectedRef.current;
      if (el) revealTab(el);
    };
    reveal();
    const ro = new ResizeObserver(reveal);
    ro.observe(elStrip);
    return () => ro.disconnect();
  }, [activeValue]);

  return (
    <div className="flex items-center gap-4">
      {/* Perspective and pin tabs share one beUI Tabs (transparent track, shared sliding pill); the +
          button sits beside it. The strip scrolls horizontally with the scrollbar hidden; the total
          stays fixed outside it. Pin panels aren't clipped: they render through a Portal (see PinPanel). */}
      <div
        ref={stripRef}
        className="min-w-0 flex-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <Tabs value={activeValue} onValueChange={selectTab} variant="pill">
          {/* Overrides beUI's default track background via twMerge. The + button lives inside TabsList
              as a placeholder sharing the tab gap; pr-4 keeps the last tab/+ off the total. */}
          <TabsList className="bg-transparent p-0 pr-4">
            <SelectedSlot on={activeValue === "tokens"} selectedRef={selectedRef}>
              <TabsTrigger value="tokens">{t("tokensTab")}</TabsTrigger>
            </SelectedSlot>
            {strip.hasPerps && (
              <SelectedSlot on={activeValue === "perps"} selectedRef={selectedRef}>
                <TabsTrigger value="perps">{t("perpsTab")}</TabsTrigger>
              </SelectedSlot>
            )}
            {strip.hasDefi && (
              <SelectedSlot on={activeValue === "defi"} selectedRef={selectedRef}>
                <TabsTrigger value="defi">{t("defiTab")}</TabsTrigger>
              </SelectedSlot>
            )}
            {pins.map((p) => (
              <SelectedSlot key={p.id} on={activeValue === p.id} selectedRef={selectedRef}>
                <PinTab pin={p} />
              </SelectedSlot>
            ))}
            <AddPinButton />
          </TabsList>
        </Tabs>
      </div>
      <TabTotal />
    </div>
  );
}

function SelectedSlot({
  on,
  selectedRef,
  children,
}: {
  on: boolean;
  selectedRef: RefObject<HTMLSpanElement | null>;
  children: ReactNode;
}) {
  return (
    <span ref={on ? selectedRef : undefined} className="inline-flex">
      {children}
    </span>
  );
}

function TabTotal() {
  const { selectedId } = usePortfolio();
  const strip = useHomeTabStrip(selectedId);
  const { shownActive } = useHomeTabSelection(strip.pins);
  const kindTabs = kindTabsOf(strip.hasPerps, strip.hasDefi);
  const activePin = strip.pins.find((p) => p.id === shownActive) ?? null;
  const pinScope = activePin ? pinScopeOf(activePin) : undefined;
  const activeKind: KindTab = kindTabs.includes(shownActive as KindTab)
    ? (shownActive as KindTab)
    : "tokens";

  return (
    // min-w-24 matches TabTotalSkeleton so the strip doesn't widen when the total swaps for a placeholder (clipped tabs would flash).
    <span className="inline-flex min-w-24 shrink-0 justify-end text-muted-foreground text-sm tabular-nums">
      {/* Pin view: show the total only once the filtered data arrives, never the unfiltered one.
          useSuspenseQuery can't be conditional, so the pin-only query is expressed by not mounting
          this component outside pin view. Total and list share a queryKey, so one request. */}
      {activePin && pinScope ? (
        <QueryBoundary
          key={activePin.id}
          resetKey={JSON.stringify(portfolioKeys.overviewCompose(selectedId, pinScope))}
          pending={<TabTotalSkeleton />}
          failed="—"
        >
          <PinTotal portfolioId={selectedId} pin={pinScope} />
        </QueryBoundary>
      ) : (
        <QueryBoundary
          resetKey={JSON.stringify(portfolioKeys.overviewCompose(selectedId))}
          pending={<TabTotalSkeleton />}
          failed="—"
        >
          <KindTotal portfolioId={selectedId} kind={activeKind} />
        </QueryBoundary>
      )}
    </span>
  );
}

function KindTotal({ portfolioId, kind }: { portfolioId: string; kind: KindTab }) {
  const usd = useDisplayValue();
  const data = usePortfolioOverview(portfolioId);
  const parts = derive(data.sections);
  const viewSubtotal =
    kind === "perps"
      ? parts.perpEquitySubtotal
      : kind === "defi"
        ? data.defiSubtotal
        : data.holdingsSubtotal;
  return <Sensitive>{usd(viewSubtotal)}</Sensitive>;
}

// Top-right total of a custom tab; same queryKey as the list below, so one request.
function PinTotal({ portfolioId, pin }: { portfolioId: string; pin: PinScopeKey }) {
  const usd = useDisplayValue();
  const data = usePortfolioOverview(portfolioId, pin);
  return <Sensitive>{usd(data.totalUsd)}</Sensitive>;
}
