import { Tabs, TabsList, TabsTrigger, toast } from "@folio/ui";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import { QueryBoundary } from "../../../components/query-boundary";
import { type KindTab, kindTabsOf } from "../../../lib/home-tabs";
import { useDisplayValue } from "../../../lib/hooks/use-display-value";
import { usePortfolio } from "../../../lib/hooks/use-portfolio";
import { type PinScopeKey, portfolioKeys } from "../../../lib/queries/keys";
import { homeTabStripQuery, portfolioOverviewQuery } from "../../../lib/queries/portfolio";
import { invalidateFor } from "../../../lib/queries/refresh";
import { createTabPin, deleteTabPin, updateTabPinTarget } from "../../../lib/server/tab-pins";
import { derive } from "./holdings";
import type { PinTargetChoice } from "./tab-pin-picker";
import { AddPinButton, PinTab } from "./tab-pins";
import { pinScopeOf, revealTab, useHomeTabSelection } from "./tab-selection";

const MAX_PINS = 3;

export function TabStripIsland() {
  const { selectedId } = usePortfolio();
  const queryClient = useQueryClient();
  const t = useTranslations("Overview");
  const tc = useTranslations("Common");
  const tct = useTranslations("CustomTabs");
  const { data: strip } = useSuspenseQuery(homeTabStripQuery(selectedId));
  const { pins } = strip;
  const { active, selectTab, shownActive } = useHomeTabSelection(pins);
  const kindTabs = kindTabsOf(strip.hasPerps, strip.hasDefi);
  const activePin = pins.find((p) => p.id === shownActive) ?? null;
  const isPinView = activePin != null;
  const pinScope = activePin ? pinScopeOf(activePin) : undefined;
  const pinBoundaryKey = pinScope
    ? JSON.stringify(portfolioKeys.overview(selectedId, pinScope))
    : "";
  const activeKind: KindTab | null = isPinView
    ? null
    : kindTabs.includes(shownActive as KindTab)
      ? (shownActive as KindTab)
      : "tokens";
  const activeValue = isPinView ? shownActive : (activeKind ?? "tokens");

  // 手机端 tab 条横向滚动:选中在可视区外/半露的 tab 要滚进可视区,两侧留余量(不贴裁剪缘/合计)。
  // 手写横向校正而非 scrollIntoView:后者会连带滚 overflow-hidden 祖先和页面纵向;且选中 pin 后合计
  // 宽度变化(「—」→ 金额)会把 strip 压窄、刚滚好的 tab 又被裁掉(实测)→ ResizeObserver 盯住
  // strip 尺寸,变了就再校正一次。pins.length 也作触发 —— 新建 pin 的 tab 等 loader 刷新才挂上。
  const stripRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖是「何时滚」的信号(选中变化/pin 增删),不是回调里读的值。
  useEffect(() => {
    const elStrip = stripRef.current;
    if (!elStrip) return;
    const reveal = () => {
      const el = elStrip.querySelector('[aria-selected="true"]');
      if (el instanceof HTMLElement) revealTab(el);
    };
    reveal();
    const ro = new ResizeObserver(reveal);
    ro.observe(elStrip);
    return () => ro.disconnect();
  }, [active, pins.length]);

  const failPin = () => toast.error(tct("actionFailed"));
  const addPinMut = useMutation({
    mutationFn: (choice: PinTargetChoice) => createTabPin({ data: choice }),
    onSuccess: async (pin) => {
      // 先等 tab 条刷新、新 tab 挂上再选中 —— 提前选中会让 active 短暂指向不存在的 tab,
      // 被 clamp 回 tokens,药丸先滑到第一个再滑回来(实测)。
      await invalidateFor(queryClient, "portfolio.pin.write");
      selectTab(pin.id);
    },
    onError: failPin,
  });
  const repointPinMut = useMutation({
    mutationFn: ({ pinId, choice }: { pinId: string; choice: PinTargetChoice }) =>
      updateTabPinTarget({ data: { pinId, ...choice } }),
    onSuccess: () => invalidateFor(queryClient, "portfolio.pin.write"),
    onError: failPin,
  });
  const unpinMut = useMutation({
    mutationFn: (pinId: string) => deleteTabPin({ data: { pinId } }),
    onSuccess: () => invalidateFor(queryClient, "portfolio.pin.write"),
    onError: failPin,
  });
  const onUnpin = (pinId: string) => {
    if (shownActive === pinId) {
      // 取消当前激活的 → 回**左邻**:前一个 pin,没有则最后一个视角 tab(别一路滑回第一个)。
      const idx = pins.findIndex((p) => p.id === pinId);
      selectTab(idx > 0 ? pins[idx - 1].id : kindTabs[kindTabs.length - 1]);
    }
    unpinMut.mutate(pinId);
  };

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

  return (
    <div className="flex items-center gap-4">
      {/* 视角(现货/永续/DeFi)与自定义 pin 共用**同一个** beUI Tabs(无背景轨道、共享滑动药丸,ADR 0034 UI 微调):
              选 pin 只是把药丸滑过去,视角 tab 原样保留、动效不变。＋ 作 Tabs 外的相邻加钮。 */}
      {/* tab 超宽(手机端 pin 多)→ **横向滚动**、隐藏滚动条(不换行);最右侧合计不进滚动区、固定不动。
                pin 面板不受此容器裁剪 —— 它整个经 Portal 浮出(见 PinPortalPopover)。 */}
      <div
        ref={stripRef}
        className="min-w-0 flex-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <Tabs value={activeValue} onValueChange={selectTab} variant="pill">
          {/* 覆盖 beUI pill 默认的 bg-card 轨道底 → 无背景(twMerge 覆盖 vendored className,不改组件)。
                    ＋ 加钮住在 TabsList 内(非 tab,只做占位),与各 tab 共享同一 gap-1 —— 和 tab 间距一致。
                    pr-4:滚动区末端留内边距,滚到底时最后一个 tab/＋ 不贴着右侧合计。 */}
          <TabsList className="bg-transparent p-0 pr-4">
            <TabsTrigger value="tokens">{t("tokensTab")}</TabsTrigger>
            {strip.hasPerps && <TabsTrigger value="perps">{t("perpsTab")}</TabsTrigger>}
            {strip.hasDefi && <TabsTrigger value="defi">{t("defiTab")}</TabsTrigger>}
            {pins.map((p) => (
              <PinTab
                key={p.id}
                value={p.id}
                isActive={shownActive === p.id}
                name={p.name}
                logo={p.logo}
                selected={{
                  kind: p.kind,
                  connectorId: p.connectorId,
                  tagId: p.tagId,
                  accountId: p.accountId,
                }}
                onRepoint={(choice) => repointPinMut.mutate({ pinId: p.id, choice })}
                onUnpin={() => onUnpin(p.id)}
                unpinning={unpinMut.isPending && unpinMut.variables === p.id}
              />
            ))}
            {pins.length < MAX_PINS && (
              <AddPinButton
                onPick={(choice) => addPinMut.mutate(choice)}
                adding={addPinMut.isPending}
              />
            )}
          </TabsList>
        </Tabs>
      </div>
      <span className="shrink-0 text-muted-foreground text-sm tabular-nums">
        {/* pin 视图:过滤后数据到位才显其总额;未到位显 "—",别显未收窄的全量总额。
                  数据由子组件自己拉 —— `useSuspenseQuery` 没有条件启用,所以「只在 pin 视图下才要的查询」
                  只能靠「不在 pin 视图时这个组件压根不挂」来表达(ADR 0038)。总额与列表是两个子组件、
                  同一个 queryKey,react-query 自然合成一次请求。 */}
        {isPinView && pinScope ? (
          <QueryBoundary key={activePin.id} resetKey={pinBoundaryKey} pending="—" failed="—">
            <PinTotal portfolioId={selectedId} pin={pinScope} />
          </QueryBoundary>
        ) : (
          <QueryBoundary
            resetKey={JSON.stringify(portfolioKeys.overview(selectedId))}
            pending="—"
            failed="—"
          >
            <KindTotal portfolioId={selectedId} kind={activeKind ?? "tokens"} />
          </QueryBoundary>
        )}
      </span>
    </div>
  );
}

function KindTotal({ portfolioId, kind }: { portfolioId: string; kind: KindTab }) {
  const usd = useDisplayValue();
  const { data } = useSuspenseQuery(portfolioOverviewQuery(portfolioId));
  const parts = derive(data.sections);
  const viewSubtotal =
    kind === "perps"
      ? parts.perpEquitySubtotal
      : kind === "defi"
        ? data.defiSubtotal
        : data.holdingsSubtotal;
  return <>{usd(viewSubtotal)}</>;
}

// 自定义 Tab 的右上角合计。与下方列表**同一个 queryKey**,react-query 只发一次请求。
function PinTotal({ portfolioId, pin }: { portfolioId: string; pin: PinScopeKey }) {
  const usd = useDisplayValue();
  const { data } = useSuspenseQuery(portfolioOverviewQuery(portfolioId, pin));
  return <>{usd(data.totalUsd)}</>;
}
