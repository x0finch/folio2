import type { TabPin } from "@folio/db";
import { Tabs, TabsContent, TabsList, TabsTrigger, toast } from "@folio/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { HeaderSync } from "../../components/header-sync";
import { DefiPositions, PerpPositionsList } from "../../components/holdings-sections";
import { PortfolioHero } from "../../components/portfolio-hero";
import { SectionList } from "../../components/section-list";
import { OverviewSkeleton } from "../../components/skeletons";
import type { PinTargetChoice } from "../../components/tab-pin-picker";
import { TabPinsBar } from "../../components/tab-pins-bar";
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

export const Route = createFileRoute("/_authed/")({
  loader: async () => {
    const [overview, history, pins, tags, accounts] = await Promise.all([
      getPortfolioOverview(),
      getPortfolioHistory(),
      listTabPins(),
      listTags(),
      listAccounts(),
    ]);
    // 自定义 Tab 选择器的备选(ADR 0034):按 Connector = 用户拥有的去重 connectorId;按 Tag = 见下(按选中 Portfolio 过滤)。
    const connectorIds = [...new Set(accounts.map((a) => a.connectorId))];
    return { ...overview, series: history.series, pins, tags, connectorIds };
  },
  pendingComponent: OverviewSkeleton,
  component: Overview,
});

// pin(db 行)→ 服务端 scope 入参形状(缺目标由服务端视作无 pin)。
function pinScopeOf(pin: TabPin | null) {
  if (!pin) return undefined;
  return pin.kind === "tag"
    ? { kind: "tag" as const, tagId: pin.tagId ?? undefined }
    : { kind: "connector" as const, connectorId: pin.connectorId ?? undefined };
}

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

  const [tab, setTab] = useState("tokens");
  const [activePinId, setActivePinId] = useState<string | null>(null);

  const { pins, tags, connectorIds } = loaderData;
  const activePin = pins.find((p) => p.id === activePinId) ?? null;
  const pinScope = pinScopeOf(activePin);
  const scoped = !isDefault || activePinId != null; // 非默认 Portfolio 或激活了 pin → 客户端按 scope 重拉

  // 选中非默认 Portfolio / 激活 pin 时按 (selectedId, pinId) 重拉;默认视图仍走 loader SSR。
  // placeholderData:切换期间保留上一份,不闪空。
  const scopedQuery = useQuery({
    queryKey: ["portfolio-overview", selectedId, activePinId],
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
  // 默认视图(无 pin)的 pricesStale 走 loader;scoped 视图由 react-query staleTime 自刷。
  useStalePriceRefresh(scoped ? undefined : loaderData.pricesStale);

  // 自定义 Tab 备选:tag 按选中 Portfolio 过滤(账户只匹配同 Portfolio 的 Tag);connector 全量。
  const connectorOptions = connectorIds.map((id) => ({ id, label: connectorLabel(id) }));
  const tagOptions = tags
    .filter((tg) => tg.portfolioId === selectedId)
    .map((tg) => ({ id: tg.id, name: tg.name }));
  const tagNameOf = (id: string) => tags.find((tg) => tg.id === id)?.name ?? "";

  const failPin = () => toast.error(tct("actionFailed"));
  const onAddPin = (choice: PinTargetChoice) => {
    createTabPin({ data: choice })
      .then((pin) => {
        setActivePinId(pin.id); // 固定后即切到它
        return router.invalidate();
      })
      .catch(failPin);
  };
  const onEditPin = (pinId: string, choice: PinTargetChoice) => {
    updateTabPinTarget({ data: { pinId, ...choice } })
      .then(() => router.invalidate())
      .catch(failPin);
  };
  const onUnpin = (pinId: string) => {
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

  // 默认视图的视角 tab(现货/永续/DeFi);自定义 Tab 激活时不用它。
  const availableTabs = [
    "tokens",
    ...(perpItems.length > 0 ? ["perps"] : []),
    ...(defiGroups.length > 0 ? ["defi"] : []),
  ];
  const activeTab = availableTabs.includes(tab) ? tab : "tokens";
  const viewSubtotal =
    activeTab === "perps"
      ? perpEquitySubtotal
      : activeTab === "defi"
        ? defiSubtotal
        : holdingsSubtotal;

  // 自定义 Tab 的 section list 段(按小计倒序,空段剔除,ADR 0034)。
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

  return (
    <div className="flex flex-col gap-6">
      <HeaderSync />

      {/* 自定义 Tab 栏(ADR 0034):有账户才显;[总览] + ≤3 pin + [＋]。 */}
      {accountTotals.length > 0 && (
        <TabPinsBar
          pins={pins}
          activePinId={activePinId}
          onSelect={setActivePinId}
          connectorLabel={connectorLabel}
          tagName={tagNameOf}
          connectorOptions={connectorOptions}
          tagOptions={tagOptions}
          onAdd={onAddPin}
          onEdit={onEditPin}
          onUnpin={onUnpin}
        />
      )}

      <PortfolioHero series={series} totalUsd={totalUsd} holdings={holdings} />

      {accountTotals.length === 0 ? (
        <p className="text-muted-foreground">
          {tc("noAccountsYet")}{" "}
          <Link to="/accounts" className="underline">
            {tc("addOne")}
          </Link>
          .
        </p>
      ) : activePinId != null ? (
        // 自定义 Tab:section list(现货/永续/DeFi 按小计倒序竖排),而非视角子 Tab。
        pinEmpty ? (
          <p className="py-12 text-center text-muted-foreground text-sm">{tct("empty")}</p>
        ) : (
          <SectionList sections={pinSections} />
        )
      ) : (
        // 默认 / Portfolio 视图:保留现有的现货/永续/DeFi 子 Tab(零改动)。
        <Tabs
          value={activeTab}
          onValueChange={setTab}
          variant="pill"
          className="flex flex-col gap-4"
        >
          <div className="flex items-center justify-between gap-4">
            <TabsList className="bg-transparent p-0">
              <TabsTrigger value="tokens">{t("tokensTab")}</TabsTrigger>
              {perpItems.length > 0 && <TabsTrigger value="perps">{t("perpsTab")}</TabsTrigger>}
              {defiGroups.length > 0 && <TabsTrigger value="defi">{t("defiTab")}</TabsTrigger>}
            </TabsList>
            <span className="text-muted-foreground text-sm tabular-nums">{usd(viewSubtotal)}</span>
          </div>

          <TabsContent value="tokens">
            {holdings.length === 0 ? (
              <p className="py-12 text-center text-muted-foreground text-sm">{t("noSnapshot")}</p>
            ) : (
              <TokenHoldings holdings={holdings} />
            )}
          </TabsContent>

          {perpItems.length > 0 && (
            <TabsContent value="perps">
              <PerpPositionsList items={perpItems} />
            </TabsContent>
          )}
          {defiGroups.length > 0 && (
            <TabsContent value="defi">
              <DefiPositions groups={defiGroups} hideHeader />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
