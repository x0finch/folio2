import { cn, toast } from "@folio/ui";
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
import { tagColor } from "../../lib/tag-color";

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
    // 自定义 Tab 选择器备选:按 Connector = 用户拥有的去重 connectorId;按 Tag = 见组件内(按选中 Portfolio 过滤)。
    const connectorIds = [...new Set(accounts.map((a) => a.connectorId))];
    return { ...overview, series: history.series, pins, tags, connectorIds };
  },
  pendingComponent: OverviewSkeleton,
  component: Overview,
});

function Overview() {
  const { selectedId, defaultId } = usePortfolio();
  const loaderData = Route.useLoaderData(); // SSR 默认视图(选中 = 默认、无 pin 时直接用)
  const isDefault = selectedId === defaultId;
  const router = useRouter();
  const t = useTranslations("Overview");
  const tc = useTranslations("Common");
  const tct = useTranslations("CustomTabs");
  const usd = useDisplayValue();
  const connectorLabel = useConnectorLabels();

  // 单一 tab 状态:"tokens" / "perps" / "defi"(视角)或 pin id(自定义 Tab)。默认 tokens。
  const [active, setActive] = useState("tokens");
  const [pickerFor, setPickerFor] = useState<
    { mode: "add" } | { mode: "edit"; pinId: string } | null
  >(null);

  const { pins, tags, connectorIds } = loaderData;
  // activePin 只看 loader 的 pins(不依赖 data)→ 可在拉取前定 scope。
  const activePin = pins.find((p) => p.id === active) ?? null;
  const isPinView = activePin != null;
  const scoped = !isDefault || isPinView; // 非默认 Portfolio 或激活 pin → 按 scope 重拉
  const pinScope = activePin
    ? activePin.kind === "tag"
      ? { kind: "tag" as const, tagId: activePin.tagId ?? undefined }
      : { kind: "connector" as const, connectorId: activePin.connectorId ?? undefined }
    : undefined;

  // key 带上 pin 目标:建 pin 即选中时 activePin 由 loader 补齐(晚一拍),目标一到位 key 变化即重拉过滤后的数据
  //(修此前「建完不过滤」的时序 bug)。placeholderData 保留上一份,不闪空。
  const scopedQuery = useQuery({
    queryKey: [
      "portfolio-overview",
      selectedId,
      activePin?.id ?? null,
      activePin?.connectorId ?? null,
      activePin?.tagId ?? null,
    ],
    queryFn: async () => {
      const [overview, history] = await Promise.all([
        getPortfolioOverview({ data: { portfolioId: selectedId, pin: pinScope } }),
        getPortfolioHistory({ data: { portfolioId: selectedId, pin: pinScope } }),
      ]);
      return { ...overview, series: history.series };
    },
    enabled: scoped,
    placeholderData: keepPreviousData,
  });
  const data = scoped ? scopedQuery.data : loaderData;
  useStalePriceRefresh(scoped ? undefined : loaderData.pricesStale);

  // 自定义 Tab 备选:tag 按选中 Portfolio 过滤(账户只匹配同 Portfolio 的 Tag);connector 全量。
  const connectorOptions = connectorIds.map((id) => ({ id, label: connectorLabel(id) }));
  const tagOptions = tags
    .filter((tg) => tg.portfolioId === selectedId)
    .map((tg) => ({ id: tg.id, name: tg.name }));

  const failPin = () => toast.error(tct("actionFailed"));
  const applyPick = (choice: PinTargetChoice) => {
    const target = pickerFor;
    setPickerFor(null);
    if (target?.mode === "edit") {
      updateTabPinTarget({ data: { pinId: target.pinId, ...choice } })
        .then(() => router.invalidate())
        .catch(failPin);
    } else {
      createTabPin({ data: choice })
        .then((pin) => {
          setActive(pin.id); // 固定后即切到它
          return router.invalidate();
        })
        .catch(failPin);
    }
  };
  const onUnpin = (pinId: string) => {
    if (active === pinId) setActive("tokens"); // 取消当前激活的 → 回代币
    deleteTabPin({ data: { pinId } })
      .then(() => router.invalidate())
      .catch(failPin);
  };

  if (!data) return <OverviewSkeleton />; // 切到 scoped 视图、首次拉取中
  const { holdings, sections, accountTotals, totalUsd, holdingsSubtotal, defiSubtotal, series } =
    data;
  const defiGroups = mergeDefiGroups(sections);
  const perpItems = sections.flatMap((s) =>
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
    (s, it) => s + (it.view.equity?.accountValue ?? 0),
    0,
  );

  // 视角 tab 的存在性 + 当前视角(非 pin 视图时用):选中的视角消失 → clamp 回代币。
  const kindTabs = [
    "tokens",
    ...(perpItems.length > 0 ? ["perps"] : []),
    ...(defiGroups.length > 0 ? ["defi"] : []),
  ];
  const activeKind = isPinView ? null : kindTabs.includes(active) ? active : "tokens";
  const viewSubtotal =
    activeKind === "perps"
      ? perpEquitySubtotal
      : activeKind === "defi"
        ? defiSubtotal
        : holdingsSubtotal;

  const pinSections = [
    {
      key: "tokens",
      title: t("tokensTab"),
      subtotal: holdingsSubtotal,
      count: holdings.length,
      content: <TokenHoldings holdings={holdings} />,
    },
    {
      key: "perps",
      title: t("perpsTab"),
      subtotal: perpEquitySubtotal,
      count: perpItems.length,
      content: <PerpPositionsList items={perpItems} />,
    },
    {
      key: "defi",
      title: t("defiTab"),
      subtotal: defiSubtotal,
      count: defiGroups.length,
      content: <DefiPositions groups={defiGroups} hideHeader />,
    },
  ];
  const pinEmpty = holdings.length === 0 && perpItems.length === 0 && defiGroups.length === 0;

  const tabClass = (on: boolean) =>
    cn(
      "flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors",
      on ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="flex flex-col gap-6">
      <HeaderSync />
      <PortfolioHero series={series} totalUsd={totalUsd} holdings={holdings} />

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
          {/* 一排 tab:视角(现货/永续/DeFi)+ 自定义 pin + ＋,共享同一行(ADR 0034)。 */}
          <div className="relative flex items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActive("tokens")}
                className={tabClass(activeKind === "tokens")}
              >
                {t("tokensTab")}
              </button>
              {perpItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => setActive("perps")}
                  className={tabClass(activeKind === "perps")}
                >
                  {t("perpsTab")}
                </button>
              )}
              {defiGroups.length > 0 && (
                <button
                  type="button"
                  onClick={() => setActive("defi")}
                  className={tabClass(activeKind === "defi")}
                >
                  {t("defiTab")}
                </button>
              )}

              {pins.map((pin) => (
                <PinTab
                  key={pin.id}
                  active={active === pin.id}
                  label={
                    pin.kind === "tag"
                      ? tagNameOf(tags, pin.tagId)
                      : connectorLabel(pin.connectorId ?? "")
                  }
                  dotColor={pin.kind === "tag" ? tagColor(pin.tagId ?? "") : undefined}
                  onSelect={() => setActive(pin.id)}
                  onEditStart={() => setPickerFor({ mode: "edit", pinId: pin.id })}
                  onUnpin={() => onUnpin(pin.id)}
                  tabClass={tabClass}
                />
              ))}

              {pins.length < MAX_PINS && (
                <button
                  type="button"
                  aria-label={tct("add")}
                  onClick={() => setPickerFor((p) => (p?.mode === "add" ? null : { mode: "add" }))}
                  className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Plus className="size-4" />
                </button>
              )}
            </div>
            <span className="text-muted-foreground text-sm tabular-nums">
              {usd(isPinView ? totalUsd : viewSubtotal)}
            </span>

            {pickerFor && (
              <div className="absolute top-full left-0 z-20 mt-1">
                <TabPinPicker
                  connectorOptions={connectorOptions}
                  tagOptions={tagOptions}
                  onPick={applyPick}
                />
              </div>
            )}
          </div>

          {/* 内容:自定义 pin → section list(按小计倒序竖排);视角 → 单类列表。 */}
          {isPinView ? (
            pinEmpty ? (
              <p className="py-12 text-center text-muted-foreground text-sm">{tct("empty")}</p>
            ) : (
              <SectionList sections={pinSections} />
            )
          ) : activeKind === "perps" ? (
            <PerpPositionsList items={perpItems} />
          ) : activeKind === "defi" ? (
            <DefiPositions groups={defiGroups} hideHeader />
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

// 单个自定义 pin tab:pill 按钮**点选**切到该 tab;**hover** 冒管理小菜单(改指向 / 取消固定,后者不二次确认)。
// 手搓的 hover 下拉(onMouseEnter/Leave + 绝对定位),不套 beUI Popover —— 那个会把点击吞掉(点不动 tab),
// 且宽触发器有 goo/blob 老坑(见 memory)。点选与管理两职责就此解耦。
function PinTab({
  active,
  label,
  dotColor,
  onSelect,
  onEditStart,
  onUnpin,
  tabClass,
}: {
  active: boolean;
  label: string;
  dotColor?: string;
  onSelect: () => void;
  onEditStart: () => void;
  onUnpin: () => void;
  tabClass: (on: boolean) => string;
}) {
  const tct = useTranslations("CustomTabs");
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 悬停只揭示管理菜单;选中与菜单项均是可键盘达的 <button>。
    <span
      className="relative"
      onMouseEnter={() => setMenuOpen(true)}
      onMouseLeave={() => setMenuOpen(false)}
    >
      <button type="button" onClick={onSelect} className={tabClass(active)}>
        {dotColor && (
          <span className="size-2 shrink-0 rounded-full" style={{ background: dotColor }} />
        )}
        {label}
      </button>
      {menuOpen && (
        <div className="absolute top-full left-0 z-30 mt-1 flex w-32 flex-col gap-0.5 rounded-xl border border-border bg-popover p-1 shadow-lg">
          <button
            type="button"
            onClick={onEditStart}
            className="rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted"
          >
            {tct("changeTarget")}
          </button>
          <button
            type="button"
            onClick={onUnpin}
            className="rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted"
          >
            {tct("unpin")}
          </button>
        </div>
      )}
    </span>
  );
}
