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

  // 手机端 tab 条横向滚动:选中在可视区外/半露的 tab 要滚进可视区,两侧留余量(不贴裁剪缘/合计)。
  // 手写横向校正而非 scrollIntoView:后者会连带滚 overflow-hidden 祖先和页面纵向;且选中 pin 后合计
  // 宽度变化(「—」→ 金额)会把 strip 压窄、刚滚好的 tab 又被裁掉(实测)→ ResizeObserver 盯住
  // strip 尺寸,变了就再校正一次。选中的 trigger 自己握 ref,不靠满条去搜 aria-selected。
  const stripRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLSpanElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeValue 是「何时滚」的信号(选中变了,ref 已经挪到新 trigger 上),回调里读的是 ref 不是这个值。
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
      {/* 视角(现货/永续/DeFi)与自定义 pin 共用**同一个** beUI Tabs(无背景轨道、共享滑动药丸,ADR 0034 UI 微调):
              选 pin 只是把药丸滑过去,视角 tab 原样保留、动效不变。＋ 作 Tabs 外的相邻加钮。 */}
      {/* tab 超宽(手机端 pin 多)→ **横向滚动**、隐藏滚动条(不换行);最右侧合计不进滚动区、固定不动。
                pin 面板不受此容器裁剪 —— 它整个经 Portal 浮出(见 PinPanel)。 */}
      <div
        ref={stripRef}
        className="min-w-0 flex-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <Tabs value={activeValue} onValueChange={selectTab} variant="pill">
          {/* 覆盖 beUI pill 默认的 bg-card 轨道底 → 无背景(twMerge 覆盖 vendored className,不改组件)。
                    ＋ 加钮住在 TabsList 内(非 tab,只做占位),与各 tab 共享同一 gap-1 —— 和 tab 间距一致。
                    pr-4:滚动区末端留内边距,滚到底时最后一个 tab/＋ 不贴着右侧合计。 */}
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
    // min-w-24 与 TabTotalSkeleton 同宽:切 pin 合计从金额变成占位时条子不能变宽,否则裁掉的 tab 会闪出来。
    <span className="inline-flex min-w-24 shrink-0 justify-end text-muted-foreground text-sm tabular-nums">
      {/* pin 视图:过滤后数据到位才显其总额;未到位走骨架,别显未收窄的全量总额。
                数据由子组件自己拉 —— `useSuspenseQuery` 没有条件启用,所以「只在 pin 视图下才要的查询」
                只能靠「不在 pin 视图时这个组件压根不挂」来表达(ADR 0038)。总额与列表是两个子组件、
                同一个 queryKey,react-query 自然合成一次请求。 */}
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

// 自定义 Tab 的右上角合计。与下方列表**同一个 queryKey**,react-query 只发一次请求。
function PinTotal({ portfolioId, pin }: { portfolioId: string; pin: PinScopeKey }) {
  const usd = useDisplayValue();
  const data = usePortfolioOverview(portfolioId, pin);
  return <Sensitive>{usd(data.totalUsd)}</Sensitive>;
}
