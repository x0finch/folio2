import { Tabs, TabsContent, TabsList, TabsTrigger } from "@folio/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { DefiPositions, PerpPositionsList } from "../../components/holdings-sections";
import { PortfolioHero } from "../../components/portfolio-hero";
import { OverviewSkeleton } from "../../components/skeletons";
import { TokenHoldings } from "../../components/token-holdings";
import { mergeDefiGroups } from "../../lib/account-view";
import { type GroupedView, toGroupedView } from "../../lib/groups-view";
import { useDisplayValue } from "../../lib/hooks/use-display-value";
import { useStalePriceRefresh } from "../../lib/hooks/use-stale-price-refresh";
import { getMyGroups } from "../../lib/server/groups";
import { getPortfolioHistory } from "../../lib/server/history";
import { getMyOverview } from "../../lib/server/overview";

export const Route = createFileRoute("/_authed/")({
  loader: async () => {
    const [overview, history, groups] = await Promise.all([
      getMyOverview(),
      getPortfolioHistory(),
      getMyGroups(),
    ]);
    return { ...overview, series: history.series, ...groups };
  },
  pendingComponent: OverviewSkeleton,
  component: Overview,
});

// 按组小计:每组一行(组名 + 小计 + 成员名),外加 Ungrouped。多组账户在多个组小计都计入;
// 组合总净值另由顶部 totalUsd(按账户去重)承载,不由这里求和。
function ByGroup({ view }: { view: GroupedView }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const labels = (accounts: { id: string; label: string }[]) =>
    accounts.length > 0 ? accounts.map((a) => a.label).join(", ") : "—";
  return (
    <div className="flex flex-col gap-3">
      {view.groups.map((s) => (
        <div key={s.group.id} className="flex items-baseline justify-between gap-4">
          <div>
            <p className="font-medium">{s.group.name}</p>
            <p className="text-sm text-muted-foreground">{labels(s.accounts)}</p>
          </div>
          <span className="text-muted-foreground">{usd(s.subtotalUsd)}</span>
        </div>
      ))}
      {view.ungrouped.accounts.length > 0 && (
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <p className="font-medium text-muted-foreground">{t("ungrouped")}</p>
            <p className="text-sm text-muted-foreground">{labels(view.ungrouped.accounts)}</p>
          </div>
          <span className="text-muted-foreground">{usd(view.ungrouped.subtotalUsd)}</span>
        </div>
      )}
    </div>
  );
}

function Overview() {
  const {
    holdings,
    sections,
    accountTotals,
    totalUsd,
    holdingsSubtotal,
    defiSubtotal,
    series,
    groups,
    memberships,
    pricesStale,
  } = Route.useLoaderData();
  const t = useTranslations("Overview");
  const tc = useTranslations("Common");
  const usd = useDisplayValue();
  useStalePriceRefresh(pricesStale); // SWR:先展示旧价,后台刷新后 invalidate 二次展示
  const grouped = toGroupedView(accountTotals, groups, memberships);
  const defiGroups = mergeDefiGroups(sections);
  const perpItems = sections.flatMap((s) =>
    s.perp && s.perp.positions.length > 0
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
  // 分组 tab 仅在有分组时存在;若选中后分组被删空(loader 重跑),受控值会指向已消失的 tab
  // → 面板全空、指示器无高亮。派生 clamp 回代币,避免陈旧选中。
  const activeTab = tab === "groups" && groups.length === 0 ? "tokens" : tab;
  // tab 右侧展示该视角合计:代币 = 现货聚合小计;DeFi & 永续 = DeFi 头寸小计(永续权益已并入代币);
  // 分组 = 组合总净值(按账户去重,组间可重叠故不求组小计之和)。
  const viewSubtotal =
    activeTab === "tokens" ? holdingsSubtotal : activeTab === "defiperp" ? defiSubtotal : totalUsd;

  return (
    <div className="flex flex-col gap-6">
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
              <TabsTrigger value="defiperp">{t("defiAndPerp")}</TabsTrigger>
              {groups.length > 0 && <TabsTrigger value="groups">{t("groupsTab")}</TabsTrigger>}
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

          <TabsContent value="defiperp">
            {sections.length === 0 ? (
              <p className="py-12 text-center text-muted-foreground text-sm">
                {t("noOpenPositions")}
              </p>
            ) : (
              // v2(H5 #120):永续单节、账户为子块(单账户退化为旧节头形态,权益降序);
              // DeFi 跨账户按协议合并成独立一节。
              <div className="flex flex-col gap-12">
                {perpItems.length > 0 && <PerpPositionsList items={perpItems} />}
                {defiGroups.length > 0 && <DefiPositions groups={defiGroups} />}
              </div>
            )}
          </TabsContent>

          {groups.length > 0 && (
            <TabsContent value="groups">
              <ByGroup view={grouped} />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
