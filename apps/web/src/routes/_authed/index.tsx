import {
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
} from "@folio/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { HeaderSync } from "../../components/header-sync";
import { DefiPositions, PerpPositionsList } from "../../components/holdings-sections";
import { PortfolioHero } from "../../components/portfolio-hero";
import { SectionList } from "../../components/section-list";
import { OverviewSkeleton } from "../../components/skeletons";
import { type PinTargetChoice, TabPinPicker } from "../../components/tab-pin-picker";
import { TokenHoldings } from "../../components/token-holdings";
import { useConnectorLabels } from "../../hooks/use-connector-labels";
import { mergeDefiGroups } from "../../lib/account-view";
import { useDisplayValue } from "../../lib/hooks/use-display-value";
import { useHoverPopover } from "../../lib/hooks/use-hover-popover";
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

export const Route = createFileRoute("/_authed/")({
  loader: async () => {
    const [overview, history, pins, tags, accounts] = await Promise.all([
      getPortfolioOverview(),
      getPortfolioHistory(),
      listTabPins(),
      listTags(),
      listAccounts(),
    ]);
    // 自定义 Tab 选择器备选:按 Connector = 用户拥有的去重 connectorId;按 Account = 全部账户(id+名);
    // 按 Tag = 见组件内(按选中 Portfolio 过滤)。
    const connectorIds = [...new Set(accounts.map((a) => a.connectorId))];
    const accountOptions = accounts.map((a) => ({ id: a.id, label: a.label }));
    return { ...overview, series: history.series, pins, tags, connectorIds, accountOptions };
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

  const { pins, tags, connectorIds, accountOptions } = loaderData;
  // activePin 只看 loader 的 pins(不依赖 data)→ 可在拉取前定 scope。
  const activePin = pins.find((p) => p.id === active) ?? null;
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
      .then((pin) => {
        setActive(pin.id); // 固定后即切到它
        return router.invalidate();
      })
      .catch(failPin);
  };
  const repointPin = (pinId: string, choice: PinTargetChoice) => {
    updateTabPinTarget({ data: { pinId, ...choice } })
      .then(() => router.invalidate())
      .catch(failPin);
  };
  const onUnpin = (pinId: string) => {
    if (active === pinId) setActive("tokens"); // 取消当前激活的 → 回代币
    deleteTabPin({ data: { pinId } })
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

  // pin 视图列表用 pin 数据;拉取前退回 Portfolio 口径,避免闪空/跳版。仅喂 pin 的 section list,不进视角 tab。
  const pinData = (isPinView ? pinQuery.data : undefined) ?? portfolioData;
  const pin = derive(pinData.sections);

  // 视角 tab 的存在性 + 当前视角(非 pin 视图时用):选中的视角消失 → clamp 回代币。
  const kindTabs = [
    "tokens",
    ...(kind.perpItems.length > 0 ? ["perps"] : []),
    ...(kind.defiGroups.length > 0 ? ["defi"] : []),
  ];
  const activeKind = isPinView ? null : kindTabs.includes(active) ? active : "tokens";
  // beUI Tabs 的受控值:视角 tab 与自定义 pin 共用**同一个** Tabs(共享滑动药丸);pin 激活时值 = pin id。
  const activeValue = isPinView ? active : (activeKind ?? "tokens");
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
          <div className="flex items-center justify-between gap-4">
            <Tabs value={activeValue} onValueChange={setActive} variant="pill">
              {/* 覆盖 beUI pill 默认的 bg-card 轨道底 → 无背景(twMerge 覆盖 vendored className,不改组件)。
                  ＋ 加钮住在 TabsList 内(非 tab,只做占位),与各 tab 共享同一 gap-1 —— 和 tab 间距一致。 */}
              <TabsList className="flex-wrap bg-transparent p-0">
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
                    label={
                      p.kind === "tag"
                        ? tagNameOf(tags, p.tagId)
                        : p.kind === "account"
                          ? accountNameOf(accountOptions, p.accountId)
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
            <span className="text-muted-foreground text-sm tabular-nums">
              {usd(isPinView ? pinData.totalUsd : viewSubtotal)}
            </span>
          </div>

          {/* 内容:自定义 pin → section list(按小计倒序竖排);视角 → 单类列表。 */}
          {isPinView ? (
            pinEmpty ? (
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

// 单个自定义 pin:本体是**普通 beUI TabsTrigger**(点选原生工作、与视角 tab 共享滑动药丸);外裹 beUI hover
// Popover —— hover 从药丸下方**流体动效**揭示管理小面板(改指向选择器 / 取消固定)。goo 颈把触发器与面板连成
// 一体、root 同时含二者,故鼠标可径直移进面板不掉。抬 z / 关闭隐垫底 / 动态方向 取自 useHoverPopover。
function PinTab({
  value,
  label,
  selected,
  connectorOptions,
  tagOptions,
  accountOptions,
  onRepoint,
  onUnpin,
}: {
  value: string;
  label: string;
  selected: PinTargetChoice;
  connectorOptions: { id: string; label: string }[];
  tagOptions: { id: string; name: string }[];
  accountOptions: { id: string; label: string }[];
  onRepoint: (choice: PinTargetChoice) => void;
  onUnpin: () => void;
}) {
  const tct = useTranslations("CustomTabs");
  const pop = useHoverPopover();
  return (
    <Popover
      trigger="hover"
      side={pop.side}
      align="start"
      panelRadius={12}
      onOpenChange={pop.onOpenChange}
      className={cn("inline-flex", pop.rootClassName)}
    >
      <PopoverTrigger>
        {/* span 包 TabsTrigger:承 measure/hover ref(TabsTrigger 非 forwardRef);点选仍走内层 tab 按钮。 */}
        <span ref={pop.measureRef} className="inline-flex">
          <TabsTrigger value={value}>{label}</TabsTrigger>
        </span>
      </PopoverTrigger>
      <PopoverContent className="p-2">
        <div className="flex w-56 flex-col gap-2">
          <TabPinPicker
            connectorOptions={connectorOptions}
            tagOptions={tagOptions}
            accountOptions={accountOptions}
            selected={selected}
            onPick={onRepoint}
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
      </PopoverContent>
    </Popover>
  );
}

// ＋固定:ghost 加钮(hover 无边框,A1),外裹 beUI hover Popover —— hover 从加钮下方流体揭示添加选择器。
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
  const pop = useHoverPopover();
  return (
    <Popover
      trigger="hover"
      side={pop.side}
      align="start"
      panelRadius={12}
      onOpenChange={pop.onOpenChange}
      className={cn("inline-flex", pop.rootClassName)}
    >
      <PopoverTrigger>
        <button
          ref={pop.measureRef}
          type="button"
          aria-label={tct("add")}
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="p-2">
        <div className="w-56">
          <TabPinPicker
            connectorOptions={connectorOptions}
            tagOptions={tagOptions}
            accountOptions={accountOptions}
            onPick={onPick}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
