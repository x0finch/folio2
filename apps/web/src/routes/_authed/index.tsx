import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@folio/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { DefiPositions, PerpPositions, useUsd } from "../../components/holdings-sections";
import { PortfolioChart } from "../../components/portfolio-chart";
import { SyncButton } from "../../components/sync-button";
import { TokenHoldings } from "../../components/token-holdings";
import { type GroupedView, toGroupedView } from "../../lib/groups-view";
import { getMyGroups } from "../../lib/server/groups";
import { getPortfolioHistory } from "../../lib/server/history";
import { getMyOverview } from "../../lib/server/overview";
import { useStalePriceRefresh } from "../../lib/use-stale-price-refresh";

export const Route = createFileRoute("/_authed/")({
  loader: async () => {
    const [overview, history, groups] = await Promise.all([
      getMyOverview(),
      getPortfolioHistory(),
      getMyGroups(),
    ]);
    return { ...overview, series: history.series, ...groups };
  },
  component: Overview,
});

// 按组小计:每组一行(组名 + 小计 + 成员名),外加 Ungrouped。多组账户在多个组小计都计入;
// 组合总净值另由顶部 totalUsd(按账户去重)承载,不由这里求和。
function ByGroup({ view }: { view: GroupedView }) {
  const t = useTranslations("Overview");
  const usd = useUsd();
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
  const usd = useUsd();
  useStalePriceRefresh(pricesStale); // SWR:先展示旧价,后台刷新后 invalidate 二次展示
  const grouped = toGroupedView(accountTotals, groups, memberships);
  const lastSyncedAt = accountTotals.reduce((m, r) => Math.max(m, r.takenAt ?? 0), 0) || null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{t("totalValue")}</p>
          <p className="text-4xl font-bold">{usd(totalUsd)}</p>
        </div>
        <SyncButton accounts={accountTotals.map((r) => r.account)} lastSyncedAt={lastSyncedAt} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("portfolioValue")}</CardTitle>
        </CardHeader>
        <CardContent>
          {series.length < 2 ? (
            <p className="text-sm text-muted-foreground">{t("notEnoughHistory")}</p>
          ) : (
            <PortfolioChart series={series} />
          )}
        </CardContent>
      </Card>

      {accountTotals.length === 0 ? (
        <p className="text-muted-foreground">
          {tc("noAccountsYet")}{" "}
          <Link to="/accounts" className="underline">
            {tc("addOne")}
          </Link>
          .
        </p>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <Tabs defaultValue="tokens">
              <TabsList>
                <TabsTrigger value="tokens">{t("tokensTab")}</TabsTrigger>
                <TabsTrigger value="defiperp">{t("defiAndPerp")}</TabsTrigger>
                {groups.length > 0 && <TabsTrigger value="groups">{t("groupsTab")}</TabsTrigger>}
              </TabsList>

              <TabsContent value="tokens" className="pt-4">
                {holdings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noSnapshot")}</p>
                ) : (
                  <>
                    <p className="mb-1 text-right text-sm text-muted-foreground">
                      {usd(holdingsSubtotal)}
                    </p>
                    <TokenHoldings holdings={holdings} />
                  </>
                )}
              </TabsContent>

              <TabsContent value="defiperp" className="pt-4">
                {sections.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noOpenPositions")}</p>
                ) : (
                  <div className="flex flex-col gap-6 overflow-x-auto">
                    <p className="text-right text-sm text-muted-foreground">{usd(defiSubtotal)}</p>
                    {sections.map((s) => (
                      <div key={s.account.id} className="flex flex-col gap-3">
                        <p className="font-medium">{s.account.label}</p>
                        {s.defi.length > 0 && <DefiPositions groups={s.defi} />}
                        {s.perp && s.perp.positions.length > 0 && <PerpPositions view={s.perp} />}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {groups.length > 0 && (
                <TabsContent value="groups" className="pt-4">
                  <ByGroup view={grouped} />
                </TabsContent>
              )}
            </Tabs>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
