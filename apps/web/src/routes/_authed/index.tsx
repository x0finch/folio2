import { Tabs, TabsContent, TabsList, TabsTrigger } from "@folio/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { HeaderSync } from "../../components/header-sync";
import { DefiPositions, PerpPositionsList } from "../../components/holdings-sections";
import { PortfolioHero } from "../../components/portfolio-hero";
import { OverviewSkeleton } from "../../components/skeletons";
import { TokenHoldings } from "../../components/token-holdings";
import { mergeDefiGroups } from "../../lib/account-view";
import { useDisplayValue } from "../../lib/hooks/use-display-value";
import { useStalePriceRefresh } from "../../lib/hooks/use-stale-price-refresh";
import { getPortfolioHistory, getPortfolioOverview } from "../../lib/server/portfolio";

export const Route = createFileRoute("/_authed/")({
  loader: async () => {
    const [overview, history] = await Promise.all([getPortfolioOverview(), getPortfolioHistory()]);
    return { ...overview, series: history.series };
  },
  pendingComponent: OverviewSkeleton,
  component: Overview,
});

function Overview() {
  const {
    holdings,
    sections,
    accountTotals,
    totalUsd,
    holdingsSubtotal,
    defiSubtotal,
    series,
    pricesStale,
  } = Route.useLoaderData();
  const t = useTranslations("Overview");
  const tc = useTranslations("Common");
  const usd = useDisplayValue();
  useStalePriceRefresh(pricesStale); // SWR:先展示旧价,后台刷新后 invalidate 二次展示
  const defiGroups = mergeDefiGroups(sections); // 空组已在 toAccountSections 出口滤除
  // 仅权益无持仓的账户也入列(code review #7):权益条可见、权益合计不缺斤短两。
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
  const [tab, setTab] = useState("tokens");
  // 数据驱动的 tab 存在性(H5 评审:永续/DeFi 拆 tab,无数据不展示):若选中的 tab 因数据
  // 变化消失(loader 重跑),受控值会指向已消失的 tab → 面板全空。派生 clamp 回代币。
  const availableTabs = [
    "tokens",
    ...(perpItems.length > 0 ? ["perps"] : []),
    ...(defiGroups.length > 0 ? ["defi"] : []),
  ];
  const activeTab = availableTabs.includes(tab) ? tab : "tokens";
  // tab 右侧展示该视角合计:代币 = 现货聚合小计;永续 = 各账户权益合计;DeFi = 头寸小计。
  const perpEquitySubtotal = perpItems.reduce(
    (s, it) => s + (it.view.equity?.accountValue ?? 0),
    0,
  );
  const viewSubtotal =
    activeTab === "perps"
      ? perpEquitySubtotal
      : activeTab === "defi"
        ? defiSubtotal
        : holdingsSubtotal;

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
        <Tabs
          value={activeTab}
          onValueChange={setTab}
          variant="pill"
          className="flex flex-col gap-4"
        >
          <div className="flex items-center justify-between gap-4">
            {/* 覆盖 beUI pill 默认的 bg-card 轨道底 → 无背景(twMerge 覆盖 vendored className,不改组件)。 */}
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

          {/* 永续/DeFi 各自成 tab,无数据不渲染(触发器同步隐藏);tab 即标题,节头 eyebrow 免了。 */}
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
