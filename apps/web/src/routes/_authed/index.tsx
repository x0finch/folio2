import { Card, CardContent, CardHeader, CardTitle } from "@folio/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { AddAccountSheet } from "../../components/add-account-sheet";
import { AccountHoldings, useUsd } from "../../components/holdings-sections";
import { PortfolioChart } from "../../components/portfolio-chart";
import { type GroupedView, toGroupedView } from "../../lib/groups-view";
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
  const { rows, totalUsd, series, groups, memberships } = Route.useLoaderData();
  const t = useTranslations("Overview");
  const tc = useTranslations("Common");
  const usd = useUsd();
  const grouped = toGroupedView(
    rows.map((r) => ({
      account: { id: r.account.id, label: r.account.label },
      totalUsd: r.totalUsd,
    })),
    groups,
    memberships,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{t("totalValue")}</p>
          <p className="text-4xl font-bold">{usd(totalUsd)}</p>
        </div>
        <AddAccountSheet />
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

      {groups.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("byGroup")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ByGroup view={grouped} />
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          {tc("noAccountsYet")}{" "}
          <Link to="/accounts" className="underline">
            {tc("addOne")}
          </Link>
          .
        </p>
      ) : (
        rows.map((row) => (
          <Card key={row.account.id}>
            <CardHeader>
              <CardTitle className="flex items-baseline justify-between">
                <span>{row.account.label}</span>
                <span className="text-base font-normal text-muted-foreground">
                  {usd(row.totalUsd)}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <AccountHoldings balances={row.balances} />
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
