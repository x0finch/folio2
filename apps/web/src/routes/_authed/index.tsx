import {
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
  useMediaQuery,
} from "@folio/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { HeaderSync } from "../../components/header-sync";
import { DefiPositions, PerpPositionsList } from "../../components/holdings-sections";
import { Portal } from "../../components/portal";
import { PortfolioHero } from "../../components/portfolio-hero";
import { SectionList } from "../../components/section-list";
import { ListSkeleton, OverviewSkeleton } from "../../components/skeletons";
import { type PinTargetChoice, TabPinPicker } from "../../components/tab-pin-picker";
import { TokenHoldings } from "../../components/token-holdings";
import { useConnectorLabels } from "../../hooks/use-connector-labels";
import { mergeDefiGroups } from "../../lib/account-view";
import { useDisplayValue } from "../../lib/hooks/use-display-value";
import { usePortfolio } from "../../lib/hooks/use-portfolio";
import { useStalePriceRefresh } from "../../lib/hooks/use-stale-price-refresh";
import { listAccounts } from "../../lib/server/accounts";
import { getPortfolioHistory, getPortfolioOverview } from "../../lib/server/portfolio";
import {
  createTabPin,
  deleteTabPin,
  listTabPins,
  updateTabPinTarget,
} from "../../lib/server/tab-pins";
import { listTags } from "../../lib/server/tags";

const MAX_PINS = 3;
const TAB_SCROLL_MARGIN = 16; // 选中 tab 滚进可视区时两侧留的余量(px)

// 把 tab(或 ＋)在横向滚动的 tab 条里滚到完全可见(两侧留余量)。手写而非 scrollIntoView:
// 后者会连带滚 overflow-hidden 祖先和页面纵向(实测踩坑)。
function revealTab(el: HTMLElement) {
  const strip = el.closest(".overflow-x-auto");
  if (!strip) return;
  const sr = strip.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  if (er.right + TAB_SCROLL_MARGIN > sr.right)
    strip.scrollLeft += er.right + TAB_SCROLL_MARGIN - sr.right;
  else if (er.left - TAB_SCROLL_MARGIN < sr.left)
    strip.scrollLeft -= sr.left - er.left + TAB_SCROLL_MARGIN;
}

export const Route = createFileRoute("/_authed/")({
  loader: async () => {
    const [overview, history, pins, tags, accounts] = await Promise.all([
      getPortfolioOverview(),
      getPortfolioHistory(),
      listTabPins(),
      listTags(),
      listAccounts(),
    ]);
    // 自定义 Tab 选择器备选:按 Connector = 用户拥有的去重 connectorId。allAccounts 是**全量**账户(id+名),
    // 只用于 pin 标签解析(pin 是 per-user、跨 Portfolio 显示 → 标签得全量才解得出);picker 的账户选项在组件内
    // 按选中 Portfolio 收窄(见 accountOptions)。按 Tag = 见组件内(按选中 Portfolio 过滤)。
    const connectorIds = [...new Set(accounts.map((a) => a.connectorId))];
    const allAccounts = accounts.map((a) => ({ id: a.id, label: a.label }));
    return { ...overview, series: history.series, pins, tags, connectorIds, allAccounts };
  },
  pendingComponent: OverviewSkeleton,
  component: Overview,
});

function Overview() {
  const { selectedId, defaultId } = usePortfolio();
  const loaderData = Route.useLoaderData(); // SSR 默认视图(选中 = 默认时直接用)
  const isDefault = selectedId === defaultId;
  const router = useRouter();
  const t = useTranslations("Overview");
  const tc = useTranslations("Common");
  const tct = useTranslations("CustomTabs");
  const usd = useDisplayValue();
  const connectorLabel = useConnectorLabels();

  // 单一 tab 状态:"tokens" / "perps" / "defi"(视角)或 pin id(自定义 Tab)。默认 tokens。
  const [active, setActive] = useState("tokens");

  const { pins, tags, connectorIds, allAccounts } = loaderData;

  // 手机端 tab 条横向滚动:选中在可视区外/半露的 tab 要滚进可视区,两侧留余量(不贴裁剪缘/合计)。
  // 手写横向校正而非 scrollIntoView:后者会连带滚 overflow-hidden 祖先和页面纵向;且选中 pin 后合计
  // 宽度变化(「—」→ 金额)会把 strip 压窄、刚滚好的 tab 又被裁掉(实测)→ ResizeObserver 盯住
  // strip 尺寸,变了就再校正一次。pins.length 也作触发 —— 新建 pin 的 tab 等 loader 刷新才挂上。
  const stripRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖是「何时滚」的信号(选中变化/pin 增删),不是回调里读的值。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const reveal = () => {
      const el = strip.querySelector('[aria-selected="true"]');
      if (el instanceof HTMLElement) revealTab(el);
    };
    reveal();
    const ro = new ResizeObserver(reveal);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [active, pins.length]);
  // active 可能短暂指向「还没挂上的 pin」—— 建 pin 后即便 await 了 invalidate,它 resolve 的时刻
  // 与新数据在组件里可见之间仍有空窗(实测)。渲染用最后一个仍有效的值,新 tab 挂上自动切过去,
  // 药丸/内容不闪回 Tokens。
  const isKnownTab = (v: string) =>
    v === "tokens" || v === "perps" || v === "defi" || pins.some((p) => p.id === v);
  const lastKnownActive = useRef("tokens");
  if (isKnownTab(active)) lastKnownActive.current = active;
  const shownActive = isKnownTab(active)
    ? active
    : isKnownTab(lastKnownActive.current)
      ? lastKnownActive.current
      : "tokens";

  // activePin 只看 loader 的 pins(不依赖 data)→ 可在拉取前定 scope。
  const activePin = pins.find((p) => p.id === shownActive) ?? null;
  const isPinView = activePin != null;
  const pinScope = activePin
    ? activePin.kind === "tag"
      ? { kind: "tag" as const, tagId: activePin.tagId ?? undefined }
      : activePin.kind === "account"
        ? { kind: "account" as const, accountId: activePin.accountId ?? undefined }
        : { kind: "connector" as const, connectorId: activePin.connectorId ?? undefined }
    : undefined;

  // hero(总额 + 曲线)始终是「选中 Portfolio」口径,**不受 pin 影响**(ADR 0034 UI 微调:自定义 Tab 不改 hero)。
  // 选中 = 默认时即 loader 那份;否则按 selectedId 重拉(不带 pin)。
  const portfolioQuery = useQuery({
    queryKey: ["portfolio-overview", selectedId],
    queryFn: async () => {
      const [overview, history] = await Promise.all([
        getPortfolioOverview({ data: { portfolioId: selectedId } }),
        getPortfolioHistory({ data: { portfolioId: selectedId } }),
      ]);
      return { ...overview, series: history.series };
    },
    enabled: !isDefault,
    placeholderData: keepPreviousData,
  });
  const portfolioData = isDefault ? loaderData : portfolioQuery.data;

  // pin 视图的列表内容:按 connector/tag 在选中 Portfolio 内再收窄(只喂列表,不进 hero)。
  // key 带上 pin 目标 → 建 pin 即选中(activePin 由 loader 补齐、晚一拍)时目标一到位即重拉过滤后的内容。
  const pinQuery = useQuery({
    queryKey: [
      "portfolio-pin",
      selectedId,
      activePin?.id ?? null,
      activePin?.connectorId ?? null,
      activePin?.tagId ?? null,
      activePin?.accountId ?? null,
    ],
    queryFn: () => getPortfolioOverview({ data: { portfolioId: selectedId, pin: pinScope } }),
    enabled: isPinView,
    placeholderData: keepPreviousData,
  });
  useStalePriceRefresh(isDefault ? loaderData.pricesStale : undefined);

  // 自定义 Tab 备选:tag 按选中 Portfolio 过滤(账户只匹配同 Portfolio 的 Tag);connector 全量。
  const connectorOptions = connectorIds.map((id) => ({ id, label: connectorLabel(id) }));
  const tagOptions = tags
    .filter((tg) => tg.portfolioId === selectedId)
    .map((tg) => ({ id: tg.id, name: tg.name }));

  const failPin = () => toast.error(tct("actionFailed"));
  const addPin = (choice: PinTargetChoice) => {
    createTabPin({ data: choice })
      .then(async (pin) => {
        // 先等 loader 刷新、新 tab 挂上再选中 —— 提前选中会让 active 短暂指向不存在的 tab,
        // 被 clamp 回 tokens,药丸先滑到第一个再滑回来(实测)。
        await router.invalidate();
        setActive(pin.id);
      })
      .catch(failPin);
  };
  const repointPin = (pinId: string, choice: PinTargetChoice) => {
    updateTabPinTarget({ data: { pinId, ...choice } })
      .then(() => router.invalidate())
      .catch(failPin);
  };

  if (!portfolioData) return <OverviewSkeleton />; // 切到非默认 Portfolio、首次拉取中
  const { totalUsd: heroTotal, series } = portfolioData;

  // 现货/永续/DeFi 三段的拆解(从某份数据的 sections 里挑出永续项 + DeFi 分组 + 永续权益小计)。
  const derive = (secs: typeof portfolioData.sections) => {
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
  };

  // 视角 tab(现货/永续/DeFi)恒按**选中 Portfolio**口径,与 pin 无关 —— 选 pin 不改这三个 tab 的存在/内容
  //(用户明确:自定义 tab 不影响原来的 tokens/perp/defi tab)。
  const { holdings, accountTotals, holdingsSubtotal, defiSubtotal } = portfolioData;
  const kind = derive(portfolioData.sections);

  // picker 的「账户」选项 = **选中 Portfolio 内**的账户(accountTotals 已是 in-view 口径)—— 与 tagOptions 同样按
  // Portfolio 收窄,避免固定到别的 Portfolio 的账户后得到一个永远空的 tab。标签解析仍走全量 allAccounts。
  const accountOptions = accountTotals.map((r) => ({ id: r.account.id, label: r.account.label }));

  // pin 视图列表用 pin 数据。pinResolved = 拉到的过滤后数据;未拉到(首拉/报错)时**不**退回全量 Portfolio
  //(那会把未收窄的全部持仓当成命中项误显),而是渲染骨架/错误态。derive 仍喂个非空对象(退回 portfolioData)
  // 只为下面结构计算不崩,真正渲染由 pinResolved 门控。
  const pinResolved = isPinView ? pinQuery.data : undefined;
  const pinData = pinResolved ?? portfolioData;
  const pin = derive(pinData.sections);

  // 视角 tab 的存在性 + 当前视角(非 pin 视图时用):选中的视角消失 → clamp 回代币。
  const kindTabs = [
    "tokens",
    ...(kind.perpItems.length > 0 ? ["perps"] : []),
    ...(kind.defiGroups.length > 0 ? ["defi"] : []),
  ];
  const activeKind = isPinView ? null : kindTabs.includes(shownActive) ? shownActive : "tokens";
  // beUI Tabs 的受控值:视角 tab 与自定义 pin 共用**同一个** Tabs(共享滑动药丸);pin 激活时值 = pin id。
  const activeValue = isPinView ? shownActive : (activeKind ?? "tokens");

  const onUnpin = (pinId: string) => {
    if (shownActive === pinId) {
      // 取消当前激活的 → 回**左邻**:前一个 pin,没有则最后一个视角 tab(别一路滑回第一个)。
      const idx = pins.findIndex((p) => p.id === pinId);
      setActive(idx > 0 ? pins[idx - 1].id : kindTabs[kindTabs.length - 1]);
    }
    deleteTabPin({ data: { pinId } })
      .then(() => router.invalidate())
      .catch(failPin);
  };
  const viewSubtotal =
    activeKind === "perps"
      ? kind.perpEquitySubtotal
      : activeKind === "defi"
        ? defiSubtotal
        : holdingsSubtotal;

  const pinSections = [
    {
      key: "tokens",
      title: t("tokensTab"),
      subtotal: pinData.holdingsSubtotal,
      count: pinData.holdings.length,
      content: <TokenHoldings holdings={pinData.holdings} />,
    },
    {
      key: "perps",
      title: t("perpsTab"),
      subtotal: pin.perpEquitySubtotal,
      count: pin.perpItems.length,
      content: <PerpPositionsList items={pin.perpItems} />,
    },
    {
      key: "defi",
      title: t("defiTab"),
      subtotal: pinData.defiSubtotal,
      count: pin.defiGroups.length,
      content: <DefiPositions groups={pin.defiGroups} hideHeader />,
    },
  ];
  const pinEmpty =
    pinData.holdings.length === 0 && pin.perpItems.length === 0 && pin.defiGroups.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <HeaderSync />
      <PortfolioHero series={series} totalUsd={heroTotal} holdings={portfolioData.holdings} />

      {accountTotals.length === 0 ? (
        <p className="text-muted-foreground">
          {tc("noAccountsYet")}{" "}
          <Link to="/accounts" className="underline">
            {tc("addOne")}
          </Link>
          .
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* 视角(现货/永续/DeFi)与自定义 pin 共用**同一个** beUI Tabs(无背景轨道、共享滑动药丸,ADR 0034 UI 微调):
              选 pin 只是把药丸滑过去,视角 tab 原样保留、动效不变。＋ 作 Tabs 外的相邻加钮。 */}
          <div className="flex items-center gap-4">
            {/* tab 超宽(手机端 pin 多)→ **横向滚动**、隐藏滚动条(不换行);最右侧合计不进滚动区、固定不动。
                pin 面板不受此容器裁剪 —— 它整个经 Portal 浮出(见 PinPortalPopover)。 */}
            <div
              ref={stripRef}
              className="min-w-0 flex-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <Tabs value={activeValue} onValueChange={setActive} variant="pill">
                {/* 覆盖 beUI pill 默认的 bg-card 轨道底 → 无背景(twMerge 覆盖 vendored className,不改组件)。
                    ＋ 加钮住在 TabsList 内(非 tab,只做占位),与各 tab 共享同一 gap-1 —— 和 tab 间距一致。
                    pr-4:滚动区末端留内边距,滚到底时最后一个 tab/＋ 不贴着右侧合计。 */}
                <TabsList className="bg-transparent p-0 pr-4">
                  <TabsTrigger value="tokens">{t("tokensTab")}</TabsTrigger>
                  {kind.perpItems.length > 0 && (
                    <TabsTrigger value="perps">{t("perpsTab")}</TabsTrigger>
                  )}
                  {kind.defiGroups.length > 0 && (
                    <TabsTrigger value="defi">{t("defiTab")}</TabsTrigger>
                  )}
                  {pins.map((p) => (
                    <PinTab
                      key={p.id}
                      value={p.id}
                      isActive={shownActive === p.id}
                      label={
                        p.kind === "tag"
                          ? tagNameOf(tags, p.tagId)
                          : p.kind === "account"
                            ? accountNameOf(allAccounts, p.accountId)
                            : connectorLabel(p.connectorId ?? "")
                      }
                      selected={{
                        kind: p.kind,
                        connectorId: p.connectorId ?? undefined,
                        tagId: p.tagId ?? undefined,
                        accountId: p.accountId ?? undefined,
                      }}
                      connectorOptions={connectorOptions}
                      tagOptions={tagOptions}
                      accountOptions={accountOptions}
                      onRepoint={(choice) => repointPin(p.id, choice)}
                      onUnpin={() => onUnpin(p.id)}
                    />
                  ))}
                  {pins.length < MAX_PINS && (
                    <AddPinButton
                      connectorOptions={connectorOptions}
                      tagOptions={tagOptions}
                      accountOptions={accountOptions}
                      onPick={addPin}
                    />
                  )}
                </TabsList>
              </Tabs>
            </div>
            <span className="shrink-0 text-muted-foreground text-sm tabular-nums">
              {/* pin 视图:过滤后数据到位才显其总额;未到位显 "—",别显未收窄的全量总额。 */}
              {isPinView ? (pinResolved ? usd(pinData.totalUsd) : "—") : usd(viewSubtotal)}
            </span>
          </div>

          {/* 内容:自定义 pin → section list(按小计倒序竖排);视角 → 单类列表。 */}
          {isPinView ? (
            !pinResolved ? (
              pinQuery.isError ? (
                <p className="py-12 text-center text-muted-foreground text-sm">
                  {tct("actionFailed")}
                </p>
              ) : (
                <ListSkeleton />
              )
            ) : pinEmpty ? (
              <p className="py-12 text-center text-muted-foreground text-sm">{tct("empty")}</p>
            ) : (
              <SectionList sections={pinSections} />
            )
          ) : activeKind === "perps" ? (
            <PerpPositionsList items={kind.perpItems} />
          ) : activeKind === "defi" ? (
            <DefiPositions groups={kind.defiGroups} hideHeader />
          ) : holdings.length === 0 ? (
            <p className="py-12 text-center text-muted-foreground text-sm">{t("noSnapshot")}</p>
          ) : (
            <TokenHoldings holdings={holdings} />
          )}
        </div>
      )}
    </div>
  );
}

function tagNameOf(tags: { id: string; name: string }[], tagId: string | null): string {
  return tags.find((tg) => tg.id === tagId)?.name ?? "";
}

function accountNameOf(
  accounts: { id: string; label: string }[],
  accountId: string | null,
): string {
  return accounts.find((a) => a.id === accountId)?.label ?? "";
}

const PIN_PANEL_W = 240; // w-56 + p-2
const PIN_PANEL_H = 340; // 面板大致高度,够不够放得下决定朝上还是朝下
const GOO_COLLAPSE_MS = 400; // beUI goo 收拢 spring 视觉时长 ~0.32s,放完再卸载浮层

// pin/＋ 的管理面板:**整个 beUI Popover 连带渲染进 Portal**(goo 动效原样保留),fixed 覆在触发器位置、
// z 高于 hero —— 既不被横向滚动容器裁(overflow-x:auto 会连带裁纵向),也不被 hero 盖住,更不会撑出页面
// 横向滚动条(fixed 不参与文档滚动)。触发器渲染 ghost(真 tab 的视觉拷贝,像素重合)且**必须有真实尺寸**
//(Popover 根 h-full w-full 撑满 fixed 盒子,否则量出 0×0 → goo 裁剪从零矩形起步,面板被自己裁没)。
// 关闭态整层不吃指针,点击照常落到底下真正的 tab;打开态点触发器区域由 beUI 自身的 click-toggle 关闭
//(面板内点击不会误触关闭)。
function PinPortalPopover({
  open,
  rect,
  ghost,
  onRequestClose,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  open: boolean;
  rect: DOMRect | null;
  ghost: React.ReactNode; // 触发器的视觉拷贝:与底下真 tab 像素重合,让 goo 药丸回到「文字底下」(原生层叠)
  onRequestClose: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: React.ReactNode;
}) {
  // 挂载/翻开分两拍走,卸载等收拢放完:
  // ① beUI Popover **首帧就带 open=true 挂载**会踩内部竞态(量尺寸的 re-render 与开场 spring 抢跑,
  //    裁剪停在 p=0、面板隐形,实测)→ 先挂载(关)、下一拍再翻开,恒走页面上其它 popover 的健康路径。
  // ② 关闭后 goo 底色在触发器位置留一块药丸 —— 原生 beUI 里它垫在触发器**底下**,portal 后整层浮在
  //    tab **上面**,不卸载就永久盖住 tab(实测)→ 收拢动画放完(GOO_COLLAPSE_MS)整个卸载。
  const [mounted, setMounted] = useState(false);
  const [openDeferred, setOpenDeferred] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setOpenDeferred(false);
    const t = setTimeout(() => setMounted(false), GOO_COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (open && mounted) setOpenDeferred(true);
  }, [open, mounted]);
  if (!rect || !mounted) return null;
  // 横向:右边放得下就左对齐触发器,否则右对齐;竖向:下方放得下就朝下,否则朝上。皆按**视口**算(已 fixed)。
  const align: "start" | "end" = rect.left + PIN_PANEL_W <= window.innerWidth - 8 ? "start" : "end";
  const side: "top" | "bottom" =
    window.innerHeight - rect.bottom > PIN_PANEL_H || rect.top < PIN_PANEL_H ? "bottom" : "top";
  return (
    <Portal>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 纯浮层容器;可交互项在面板内,tab 本身可键盘达。 */}
      <div
        style={{
          position: "fixed",
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          zIndex: 60,
          pointerEvents: open ? "auto" : "none", // 关闭态不挡底下的 tab 点击
        }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <Popover
          open={openDeferred}
          trigger="click"
          side={side}
          align={align}
          // 16 = tab 药丸 rounded-full 的半径(高 32 的一半):beUI 的 goo 触发药丸半径取
          // min(tH/2, panelRadius),给 16 才与 ghost/真 tab 圆角完全重合,不然深色角会露出来。
          panelRadius={16}
          onOpenChange={(next) => {
            if (!next) onRequestClose(); // beUI 的点外部/Esc/点触发器关闭,统一回流到调用方
          }}
          // h-full w-full:让根撑满 fixed 盒子 → 触发器量出真实尺寸(0×0 会毁掉 goo 几何)。
          className="h-full w-full"
        >
          <PopoverTrigger>
            {/* ghost 在 goo 层(z-[-1])之上 —— 复刻原生 beUI 的层叠:药丸在触发器底下,动画全程不遮字。 */}
            <span className="flex h-full w-full items-center justify-center">{ghost}</span>
          </PopoverTrigger>
          <PopoverContent className="p-2">{children}</PopoverContent>
        </Popover>
      </div>
    </Portal>
  );
}

// 开合行为(需求 9:桌面/手机一致):gateOpen 不过就**绝不开** —— pin 必须先选中(首点只选中,
// 再点已选中的才开);＋ 无「选中」一说,首次触发即开。桌面额外有 hover:已选中的 pin 移上去即开、
// 移开延迟一点再关(便于从 tab 挪进面板);未选中的 hover 不开。滚动/缩放即关,避免 fixed 浮层与触发器脱节。
function usePinPanel(canHover: boolean, gateOpen: () => boolean) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const show = () => {
    clear();
    const a = anchorRef.current;
    if (a) revealTab(a); // 半裁的触发器先滚进可视区再量位 —— 否则 fixed 浮层会按未裁坐标悬到合计上
    const r = a?.getBoundingClientRect();
    if (r) setRect(r);
    setOpen(true);
  };
  const close = () => {
    clear();
    setOpen(false);
  };
  const hideSoon = () => {
    clear();
    timer.current = setTimeout(() => setOpen(false), 140);
  };
  // 浮层是 fixed 的:触发器一移位就与面板脱节 → 关掉。两道过滤,只关「真脱节」:
  // ① 滚动的容器不包含触发器(= 面板内部滚动,选择器 overflow-y-auto)→ 不关;
  // ② 触发器量出来没动(show() 里 revealTab 自滚的 scroll 事件是异步到的,不算脱节)→ 不关。
  // resize 一律关。
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && anchorRef.current && !t.contains(anchorRef.current)) return;
      const r = anchorRef.current?.getBoundingClientRect();
      if (r && rect && Math.abs(r.left - rect.left) < 1 && Math.abs(r.top - rect.top) < 1) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, rect]);
  const hoverProps = canHover
    ? {
        onMouseEnter: () => {
          if (gateOpen()) show(); // 未选中的 pin hover 不开(需求 9)
        },
        onMouseLeave: hideSoon,
      }
    : {};
  const onClick = () => {
    if (open) close();
    else if (gateOpen()) show(); // 首点选中时 isActive 还是旧值 false → 只选中不开;再点才开
  };
  return { anchorRef, open, rect, show, close, hideSoon, clear, hoverProps, onClick };
}

// 单个自定义 pin:本体是**普通 beUI TabsTrigger**(点选原生工作、与视角 tab 共享滑动药丸);
// 管理面板经 PinPortalPopover 浮出(改指向选择器 / 取消固定)。
function PinTab({
  value,
  label,
  isActive,
  selected,
  connectorOptions,
  tagOptions,
  accountOptions,
  onRepoint,
  onUnpin,
}: {
  value: string;
  label: string;
  isActive: boolean;
  selected: PinTargetChoice;
  connectorOptions: { id: string; label: string }[];
  tagOptions: { id: string; name: string }[];
  accountOptions: { id: string; label: string }[];
  onRepoint: (choice: PinTargetChoice) => void;
  onUnpin: () => void;
}) {
  const tct = useTranslations("CustomTabs");
  const canHover = useMediaQuery("(hover: hover)");
  // 桌面/触屏一致(需求 9):必须先选中才可开面板 —— 首点选中(此刻 isActive 仍是旧值 false)不开,
  // 再点已选中的才开;桌面上已选中的 hover 也开。
  const p = usePinPanel(canHover, () => isActive);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 内层 TabsTrigger 才是可键盘达的交互元素;此层只承 hover/tap 揭示面板。
    // biome-ignore lint/a11y/useKeyWithClickEvents: 同上 —— 选中/面板项均可键盘达,此层只是触屏 tap 的包装。
    <span
      ref={p.anchorRef as React.RefObject<HTMLSpanElement>}
      className="inline-flex"
      onClick={p.onClick}
      {...p.hoverProps}
    >
      <TabsTrigger value={value}>{label}</TabsTrigger>
      <PinPortalPopover
        open={p.open}
        rect={p.rect}
        // 视觉拷贝随 isActive 走:面板只在选中时开(白药丸),但关闭动画期间可能已切走(还原成灰字)。
        ghost={
          <span
            className={cn(
              "inline-flex h-full w-full items-center justify-center whitespace-nowrap rounded-full font-medium text-sm",
              isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
        }
        onRequestClose={p.close}
        onMouseEnter={canHover ? p.clear : undefined}
        onMouseLeave={canHover ? p.hideSoon : undefined}
      >
        <div className="flex w-56 flex-col gap-2">
          <TabPinPicker
            connectorOptions={connectorOptions}
            tagOptions={tagOptions}
            accountOptions={accountOptions}
            selected={selected}
            onPick={(choice) => {
              onRepoint(choice);
              p.close();
            }}
          />
          {/* 分割线:把「取消固定」与上面的选择器隔开(独立直线,不挂在带圆角按钮上)。 */}
          <div className="border-border border-t" />
          <button
            type="button"
            onClick={onUnpin}
            className="rounded-md px-2 py-1.5 text-left text-destructive text-sm transition-colors hover:bg-destructive/10"
          >
            {tct("unpin")}
          </button>
        </div>
      </PinPortalPopover>
    </span>
  );
}

// ＋固定:ghost 加钮(hover 无边框,A1);面板同样浮出 —— 桌面 hover、触屏首点即开。
function AddPinButton({
  connectorOptions,
  tagOptions,
  accountOptions,
  onPick,
}: {
  connectorOptions: { id: string; label: string }[];
  tagOptions: { id: string; name: string }[];
  accountOptions: { id: string; label: string }[];
  onPick: (choice: PinTargetChoice) => void;
}) {
  const tct = useTranslations("CustomTabs");
  const canHover = useMediaQuery("(hover: hover)");
  const p = usePinPanel(canHover, () => true); // ＋ 只有「开面板」一个动作
  return (
    <span
      ref={p.anchorRef as React.RefObject<HTMLSpanElement>}
      className="inline-flex"
      {...p.hoverProps}
    >
      <button
        type="button"
        aria-label={tct("add")}
        onClick={p.onClick}
        className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-4" />
      </button>
      <PinPortalPopover
        open={p.open}
        rect={p.rect}
        ghost={<Plus className="size-4 text-muted-foreground" />}
        onRequestClose={p.close}
        onMouseEnter={canHover ? p.clear : undefined}
        onMouseLeave={canHover ? p.hideSoon : undefined}
      >
        <div className="w-56">
          <TabPinPicker
            connectorOptions={connectorOptions}
            tagOptions={tagOptions}
            accountOptions={accountOptions}
            onPick={(choice) => {
              onPick(choice);
              p.close();
            }}
          />
        </div>
      </PinPortalPopover>
    </span>
  );
}
