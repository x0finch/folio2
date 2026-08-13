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
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { HeaderSync } from "../../components/header-sync";
import { DefiPositions, PerpPositionsList } from "../../components/holdings-sections";
import { PinTargetLabel } from "../../components/pin-target-label";
import { Portal } from "../../components/portal";
import { PortfolioHero } from "../../components/portfolio-hero";
import { QueryBoundary } from "../../components/query-boundary";
import { SectionList } from "../../components/section-list";
import { ListSkeleton, OverviewSkeleton } from "../../components/skeletons";
import { type PinTargetChoice, TabPinPicker } from "../../components/tab-pin-picker";
import { TokenHoldings } from "../../components/token-holdings";
import { useConnectorLabels } from "../../hooks/use-connector-labels";
import { mergeDefiGroups } from "../../lib/account-view";
import { useDisplayValue } from "../../lib/hooks/use-display-value";
import { useHoldHeight } from "../../lib/hooks/use-hold-height";
import { usePortfolio } from "../../lib/hooks/use-portfolio";
import { useStalePriceRefresh } from "../../lib/hooks/use-stale-price-refresh";
import { DEFAULT_TAB, KIND_TABS, type KindTab, pickShownTab } from "../../lib/page-tabs";
import { accountListQuery } from "../../lib/queries/accounts";
import { connectorCatalogQuery } from "../../lib/queries/connectors";
import { type PinScopeKey, portfolioKeys } from "../../lib/queries/keys";
import {
  type PortfolioOverview,
  portfolioHistoryQuery,
  portfolioListQuery,
  portfolioOverviewQuery,
  tabPinsQuery,
} from "../../lib/queries/portfolio";
import { invalidateFor } from "../../lib/queries/refresh";
import { tagListQuery } from "../../lib/queries/tags";
import { createTabPin, deleteTabPin, updateTabPinTarget } from "../../lib/server/tab-pins";

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
  // 主 tab 进 URL(ADR 0043):刷新还停在原 tab、链接能分享,滚动位置也按 href 分开记(片1)。
  // **这里只校验形状,不校验值** —— 与 insights 的 `dim` 不同(那边合法值是有限集,回落已收进
  // `validateSearch`):这里的合法值含自定义 Tab 的 pin id,是运行时数据,route 层根本不知道有哪些。
  // 所以认不出的值(pin 被删、手写乱码)只能由组件那套 clamp 回落,见下面的 `shownActive`。
  // `token` = 打开的代币详情抽屉(哪个币,值是 Holding 的分组键)。同样只校验形状:那个键是
  // 运行时数据(tokenId / `no-token:…`),认不出的由 TokenHoldings 当作没开,见那里的 `selected`。
  validateSearch: (search: Record<string, unknown>): { tab?: string; token?: string } => {
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
    return { tab: str(search.tab), token: str(search.token) };
  },
  // 默认 tab 不写进 URL:`/` 就是 tokens,只有别的 tab 才挂 `?tab=`。交给官方中间件在建地址时统一剥,
  // 而不是每个导航调用点自己记得把默认值抹成 undefined。(`token` 没有默认值,不参与。)
  search: { middlewares: [stripSearchParams({ tab: DEFAULT_TAB })] },
  // 本页的读取**已全部迁到 react-query**(ADR 0038):loader 只**预取**、不返回任何数据,
  // 组件按选中的组合 id 从缓存读(本文件已无 `useLoaderData`)。
  loader: async ({ context: { queryClient } }) => {
    // 与「选中哪个组合」无关的三件事先发出去,不等下面那个 await。
    const unscoped = Promise.all([
      // connector 展示名/图的目录:pin 标签与账户抽屉都要它,首帧拿不到就只能显兜底名(#467)。
      queryClient.ensureQueryData(connectorCatalogQuery()),
      queryClient.ensureQueryData(tabPinsQuery()),
      queryClient.ensureQueryData(accountListQuery()),
      queryClient.ensureQueryData(tagListQuery()),
    ]);
    // 首屏口径 = 默认组合。**必须拿到真实的 defaultId**:组件是按 selectedId 读缓存的,
    // 预取时用「缺省 = 服务端自己定默认」的空参数,key 就与组件那份对不上,首屏等于白拉一遍。
    const { defaultId } = await queryClient.ensureQueryData(portfolioListQuery());
    await Promise.all([
      unscoped,
      queryClient.ensureQueryData(portfolioOverviewQuery(defaultId)),
      queryClient.ensureQueryData(portfolioHistoryQuery(defaultId)),
    ]);
  },
  pendingComponent: OverviewSkeleton,
  component: Overview,
});

// 代币详情抽屉的开合(URL 的 `?token=`,ADR 0043)。放在本文件里而不是抽成公共 hook:它要用
// **本 route 的** `Route.useSearch`/`useNavigate` —— 全局的 `useSearch({ from })` 目前用不了
// (`Register` 在 routeTree.gen.ts 与 router.tsx 里各声明了一遍,合并后 from 的路径联合解析成
// `never`,那是既存问题,不在这一片里动)。两个调用点(主列表 / 自定义 Tab)各调一次,逻辑只写一遍。
function useTokenParam() {
  const { token } = Route.useSearch();
  const navigate = Route.useNavigate();
  // `replace` + `resetScroll: false` 与主 tab 一致:开合抽屉不进后退栈(否则系统返回键变成
  // 「倒放我刚点过的每一下」),也不该把身后的列表弹回顶部。
  const onSelect = (key: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, token: key }), replace: true, resetScroll: false });
  return { selectedKey: token, onSelect };
}

// 现货/永续/DeFi 三段的拆解(从某份数据的 sections 里挑出永续项 + DeFi 分组 + 永续权益小计)。
// 纯函数,提到模块级 —— 自定义 Tab 的内容现在由子组件自己拉数据、自己拆(见 PinContent)。
function derive(secs: PortfolioOverview["sections"]) {
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

function Overview() {
  const { selectedId } = usePortfolio();
  const queryClient = useQueryClient();
  const t = useTranslations("Overview");
  const tc = useTranslations("Common");
  const tct = useTranslations("CustomTabs");
  const usd = useDisplayValue();
  const connectorLabel = useConnectorLabels();

  // 单一 tab 状态:"tokens" / "perps" / "defi"(视角)或 pin id(自定义 Tab)。默认 tokens。
  // **住在 URL 里**(ADR 0043):刷新回原 tab、链接可分享,每个 tab 各记自己的滚动位置。
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const active = tab ?? DEFAULT_TAB;
  // `replace` 而不是 push:iOS/Android 的原生约定都是 tab 切换**不进**后退栈,否则系统返回键
  // 变成「倒放我刚点过的每一下」。默认 tab 写成 `undefined` → 从 URL 里去掉,不留 `?tab=tokens`。
  //
  // 切到自定义 Tab 会挂起(那份数据按 pin 另拉一遍),以前靠 `startTransition` 包着才不闪骨架 ——
  // 现在不用了:router 的所有导航本来就跑在 React transition 里(`Transitioner` 把
  // `router.startTransition` 换成了 `React.startTransition`,`Link` 上那个同名 prop 因此被标了废弃)。
  //
  // `resetScroll: false` 是**必须的**:router 的 scrollRestoration 把 `?tab=` 变化当成一个新地址,
  // 新地址没有滚动记录 → 主动 `scrollTo({top:0})`(调用点抓到过)。实测滚到 y=600 点一下 tab,画面
  // 自己弹回顶部,观感就是「整页刷新了一下」;而 tab 条本身在页面中段,弹到顶等于把刚点的东西顶出视野。
  //
  // 换内容那一下高度会塌、滚动位置被浏览器夹掉,是**另一件事**(main 上就有)→ `useHoldHeight`。
  const { ref: contentRef, hold } = useHoldHeight(active);
  const selectTab = (v: string) => {
    if (v === active) return; // 值没变就别导航 —— 也别撑高度,那样就没有下一轮渲染去放开它
    hold();
    // 默认 tab 不必在这里抹成 undefined —— `stripSearchParams` 中间件在建地址时统一剥掉。
    navigate({
      search: (prev) => ({ ...prev, tab: v }),
      replace: true,
      resetScroll: false,
    });
  };

  const tokenParam = useTokenParam();

  const { data: tags } = useSuspenseQuery(tagListQuery());
  const { data: pins } = useSuspenseQuery(tabPinsQuery());
  // 自定义 Tab 选择器备选:按 Connector = 用户拥有的去重 connectorId。allAccounts 是**全量**账户(id+名),
  // 只用于 pin 标签解析(pin 是 per-user、跨 Portfolio 显示 → 标签得全量才解得出);picker 的账户选项在下面
  // 按选中 Portfolio 收窄(见 accountOptions)。按 Tag = 再往下(按选中 Portfolio 过滤)。
  const { data: allAccountRows } = useSuspenseQuery(accountListQuery());
  const connectorIds = useMemo(
    () => [...new Set(allAccountRows.map((a) => a.connectorId))],
    [allAccountRows],
  );
  const allAccounts = useMemo(
    () => allAccountRows.map((a) => ({ id: a.id, label: a.label })),
    [allAccountRows],
  );

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
  // tab 进 URL 之后这段**同时**兼了另一件事:`?tab=` 指向一个不存在的 pin(被删了、或手写乱码)时
  // 回落到默认 tab —— 不空白、不报错。URL 上那个死值**故意不清掉**:清它就得区分「这个 pin 不存在」
  // 与「这个 pin 还没挂上」,而后者正是上面那段存在的理由。
  const isKnownTab = (v: string) =>
    KIND_TABS.includes(v as KindTab) || pins.some((p) => p.id === v);
  const lastKnownActive = useRef<string>(DEFAULT_TAB);
  if (isKnownTab(active)) lastKnownActive.current = active;
  const shownActive = pickShownTab(active, lastKnownActive.current, isKnownTab);

  // activePin 只看 pins(不依赖具体数据)→ 可在拉取前定 scope。
  const activePin = pins.find((p) => p.id === shownActive) ?? null;
  const isPinView = activePin != null;
  const pinScope: PinScopeKey | undefined = activePin
    ? activePin.kind === "tag"
      ? { kind: "tag", tagId: activePin.tagId ?? undefined }
      : activePin.kind === "account"
        ? { kind: "account", accountId: activePin.accountId ?? undefined }
        : { kind: "connector", connectorId: activePin.connectorId ?? undefined }
    : undefined;
  // 「这一格在看什么」——两个 QueryBoundary 的复位依据。用的就是那两个子组件实际读的 queryKey:
  // 改 pin 目标时 pin 的 id 不变、但这个字符串会变,于是失败态跟着复位(见 components/query-boundary)。
  const pinBoundaryKey = pinScope
    ? JSON.stringify(portfolioKeys.overview(selectedId, pinScope))
    : "";

  // hero(总额 + 曲线)始终是「选中 Portfolio」口径,**不受 pin 影响**(ADR 0034 UI 微调:自定义 Tab 不改 hero)。
  // 默认与非默认走**同一个查询工厂**,只是 portfolioId 不同 —— 以前默认那份来自 loader、非默认那份是另一个
  // useQuery,两边 key 不同族,于是整页刷新只能碰到前者(停在非默认组合上做任何写操作画面都不动)。
  const { data: portfolioData } = useSuspenseQuery(portfolioOverviewQuery(selectedId));
  const { data: history } = useSuspenseQuery(portfolioHistoryQuery(selectedId));
  useStalePriceRefresh(portfolioData.pricesStale);

  // 自定义 Tab 备选:tag 按选中 Portfolio 过滤(账户只匹配同 Portfolio 的 Tag);connector 全量。
  const connectorOptions = connectorIds.map((id) => ({ id, label: connectorLabel(id) }));
  const tagOptions = tags
    .filter((tg) => tg.portfolioId === selectedId)
    .map((tg) => ({ id: tg.id, name: tg.name }));

  // 自定义 Tab 的三处写。三个都只做「刷 Tab 清单 + 失败弹一句」,所以 onSuccess/onError 长得像;
  // 分成三个 mutation 而不是一个,是为了各自有独立的 isPending —— 见 ＋ 钮与「取消固定」的 disabled。
  const failPin = () => toast.error(tct("actionFailed"));
  const addPinMut = useMutation({
    mutationFn: (choice: PinTargetChoice) => createTabPin({ data: choice }),
    onSuccess: async (pin) => {
      // 先等 Tab 清单刷新、新 tab 挂上再选中 —— 提前选中会让 active 短暂指向不存在的 tab,
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

  const { totalUsd: heroTotal } = portfolioData;
  const series = history.series;

  // 视角 tab(现货/永续/DeFi)恒按**选中 Portfolio**口径,与 pin 无关 —— 选 pin 不改这三个 tab 的存在/内容
  //(用户明确:自定义 tab 不影响原来的 tokens/perp/defi tab)。
  const { holdings, accountTotals, holdingsSubtotal, defiSubtotal } = portfolioData;
  const kind = derive(portfolioData.sections);

  // picker 的「账户」选项 = **选中 Portfolio 内**的账户(accountTotals 已是 in-view 口径)—— 与 tagOptions 同样按
  // Portfolio 收窄,避免固定到别的 Portfolio 的账户后得到一个永远空的 tab。标签解析仍走全量 allAccounts。
  const accountOptions = accountTotals.map((r) => ({ id: r.account.id, label: r.account.label }));

  // 视角 tab 的存在性 + 当前视角(非 pin 视图时用):选中的视角消失 → clamp 回代币。
  const kindTabs = [
    "tokens",
    ...(kind.perpItems.length > 0 ? ["perps"] : []),
    ...(kind.defiGroups.length > 0 ? ["defi"] : []),
  ];
  const activeKind = isPinView ? null : kindTabs.includes(shownActive) ? shownActive : "tokens";
  // beUI Tabs 的受控值:视角 tab 与自定义 pin 共用**同一个** Tabs(共享滑动药丸);pin 激活时值 = pin id。
  const activeValue = isPinView ? shownActive : (activeKind ?? "tokens");

  // 删 pin 定义在这里(不和上面两个挨着):它要先按 kindTabs / pins 算「回到哪个左邻」,
  // 而 kindTabs 依赖上面那段 portfolioData 的推导 —— 挪上去就得把那一段也搬上去。
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
  const viewSubtotal =
    activeKind === "perps"
      ? kind.perpEquitySubtotal
      : activeKind === "defi"
        ? defiSubtotal
        : holdingsSubtotal;

  return (
    <div className="flex flex-col gap-6">
      <HeaderSync />
      <PortfolioHero
        series={series}
        totalUsd={heroTotal}
        gain24h={portfolioData.gain24h ?? null}
        holdings={portfolioData.holdings}
      />

      {accountTotals.length === 0 ? (
        <p className="text-muted-foreground">
          {tc("noAccountsYet")}{" "}
          <Link to="/accounts" className="underline">
            {tc("addOne")}
          </Link>
          .
        </p>
      ) : (
        // 这个容器就是换 tab 时会塌的那块(tab 条 + 内容)—— 撑住它就够了。
        <div ref={contentRef} className="flex flex-col gap-4">
          {/* 视角(现货/永续/DeFi)与自定义 pin 共用**同一个** beUI Tabs(无背景轨道、共享滑动药丸,ADR 0034 UI 微调):
              选 pin 只是把药丸滑过去,视角 tab 原样保留、动效不变。＋ 作 Tabs 外的相邻加钮。 */}
          <div className="flex items-center gap-4">
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
                      // connector 的展示名由 PinTargetLabel 走 registry 取(类型名),这里只喂 tag/account 的名字。
                      label={
                        p.kind === "tag"
                          ? tagNameOf(tags, p.tagId)
                          : p.kind === "account"
                            ? accountNameOf(allAccounts, p.accountId)
                            : ""
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
                      onRepoint={(choice) => repointPinMut.mutate({ pinId: p.id, choice })}
                      onUnpin={() => onUnpin(p.id)}
                      unpinning={unpinMut.isPending && unpinMut.variables === p.id}
                    />
                  ))}
                  {pins.length < MAX_PINS && (
                    <AddPinButton
                      connectorOptions={connectorOptions}
                      tagOptions={tagOptions}
                      accountOptions={accountOptions}
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
                usd(viewSubtotal)
              )}
            </span>
          </div>

          {/* 内容:自定义 pin → section list(按小计倒序竖排);视角 → 单类列表。 */}
          {isPinView && pinScope ? (
            <QueryBoundary
              key={activePin.id}
              resetKey={pinBoundaryKey}
              pending={<ListSkeleton />}
              failed={
                <p className="py-12 text-center text-muted-foreground text-sm">
                  {tct("actionFailed")}
                </p>
              }
            >
              <PinContent portfolioId={selectedId} pin={pinScope} />
            </QueryBoundary>
          ) : activeKind === "perps" ? (
            <PerpPositionsList items={kind.perpItems} />
          ) : activeKind === "defi" ? (
            <DefiPositions groups={kind.defiGroups} hideHeader />
          ) : holdings.length === 0 ? (
            <p className="py-12 text-center text-muted-foreground text-sm">{t("noSnapshot")}</p>
          ) : (
            <TokenHoldings holdings={holdings} {...tokenParam} />
          )}
        </div>
      )}
    </div>
  );
}

// 自定义 Tab 的两块内容 —— 右上角合计与下方列表。**同一个 queryKey,两个组件**:
// 它们在 DOM 里隔得远,没法由一个组件同时渲染;而共用一个 key 意味着 react-query 只发一次请求,
// 两边同时到位。`useSuspenseQuery` 的 data 恒非 undefined —— 「拉到没拉到」不再是渲染分支,
// 而是由外面那层 QueryBoundary 表达。

function PinTotal({ portfolioId, pin }: { portfolioId: string; pin: PinScopeKey }) {
  const usd = useDisplayValue();
  const { data } = useSuspenseQuery(portfolioOverviewQuery(portfolioId, pin));
  return <>{usd(data.totalUsd)}</>;
}

function PinContent({ portfolioId, pin }: { portfolioId: string; pin: PinScopeKey }) {
  const t = useTranslations("Overview");
  const tct = useTranslations("CustomTabs");
  const { data } = useSuspenseQuery(portfolioOverviewQuery(portfolioId, pin));
  const parts = derive(data.sections);
  const tokenParam = useTokenParam();

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
          content: <TokenHoldings holdings={data.holdings} {...tokenParam} />,
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
          content: <DefiPositions groups={parts.defiGroups} hideHeader />,
        },
      ]}
    />
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
  unpinning,
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
  /** **这一个 pin** 的删除在飞 —— 禁掉它的「取消固定」,免得连点两次发两个 delete。
   *  必须按 pin 收窄(`variables === value`):`unpinMut` 是整页共用的一条,直接传 `isPending`
   *  会把**所有** pin 的这颗钮一起禁掉,而其中只有一个真的在删。 */
  unpinning: boolean;
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
      <TabsTrigger value={value}>
        {/* 类型标记(#351 ②):tag `#名` / account `@名` / connector `logo + 类型名`。
            激活时药丸是浅底 → onPrimary 让 logo 的底盘随之改色,不叠成两块白。 */}
        <PinTargetLabel target={selected} name={label} onPrimary={isActive} />
      </TabsTrigger>
      <PinPortalPopover
        open={p.open}
        rect={p.rect}
        // 视觉拷贝随 isActive 走:面板只在选中时开(白药丸),但关闭动画期间可能已切走(还原成灰字)。
        ghost={
          <span
            className={cn(
              "inline-flex h-full w-full items-center justify-center whitespace-nowrap rounded-full px-3.5 font-medium text-sm",
              isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground",
            )}
          >
            <PinTargetLabel target={selected} name={label} onPrimary={isActive} />
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
            disabled={unpinning}
            className="rounded-md px-2 py-1.5 text-left text-destructive text-sm transition-colors hover:bg-destructive/10 disabled:opacity-50"
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
  adding,
}: {
  connectorOptions: { id: string; label: string }[];
  tagOptions: { id: string; name: string }[];
  accountOptions: { id: string; label: string }[];
  onPick: (choice: PinTargetChoice) => void;
  /** 建 pin 在飞 —— 禁掉 ＋。`pins.length < MAX_PINS` 这道闸是拿**刷新前**的清单算的,所以在飞
   *  期间 ＋ 还在,不禁的话手快能再挑一个。**真正兜住上限的是数据库那道**
   *  (`packages/db/src/queries/tab-pins.ts` 的 `MAX_TAB_PINS_PER_USER`,超了直接拒),这里挡的
   *  只是「让用户白挑一次、再吃一个报错」。
   *
   *  `disabled` 就够,不用再去 gate `usePinPanel`:hover 开面板的监听虽然挂在外层 `<span>` 上,
   *  但 Chrome 不会从 disabled 的表单控件派发鼠标事件,那个 mouseover 压根到不了 React(实测)。 */
  adding: boolean;
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
        disabled={adding}
        className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
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
