import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@folio/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useFormatter, useTranslations } from "use-intl";
import { PortfolioChart } from "../../components/portfolio-chart";
import { type DefiGroup, type SpotRow, toAccountSections } from "../../lib/account-view";
import { type GroupedView, toGroupedView } from "../../lib/groups-view";
import type { PerpView } from "../../lib/perp";
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

// locale 感知的美元格式化(货币恒 USD,locale 决定分隔符)。
function useUsd() {
  const format = useFormatter();
  return (n: number) => format.number(n, { style: "currency", currency: "USD" });
}

// 现货/CEX/manual:数量 + 美元价值。
function SpotTable({ rows }: { rows: SpotRow[] }) {
  const t = useTranslations("Overview");
  const usd = useUsd();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("asset")}</TableHead>
          <TableHead className="text-right">{t("amount")}</TableHead>
          <TableHead className="text-right">{t("value")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((b) => (
          <TableRow key={b.id}>
            <TableCell>{b.symbol}</TableCell>
            <TableCell className="text-right">{b.amount}</TableCell>
            <TableCell className="text-right">{usd(b.usdValue)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// DeFi:按协议分组,每组一张小表(Asset / 仓位类型 / 价值)。负值=负债(借出)→ 标红。
function DefiPositions({ groups }: { groups: DefiGroup[] }) {
  const t = useTranslations("Overview");
  const usd = useUsd();
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.protocol} className="flex flex-col gap-2">
          <p className="text-sm font-medium">{g.protocol}</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("asset")}</TableHead>
                <TableHead>{t("type")}</TableHead>
                <TableHead className="text-right">{t("value")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.symbol}</TableCell>
                  <TableCell className="capitalize text-muted-foreground">
                    {r.positionType ?? "—"}
                  </TableCell>
                  <TableCell className={`text-right ${r.usdValue < 0 ? "text-destructive" : ""}`}>
                    {usd(r.usdValue)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}

// 永续:净值由卡标题承载;此处展示可提/保证金副行 + 仓位明细(方向/盈亏/杠杆/强平)。
function PerpPositions({ view }: { view: PerpView }) {
  const t = useTranslations("Overview");
  const usd = useUsd();
  const { equity, positions } = view;
  return (
    <div className="flex flex-col gap-3">
      {equity && (
        <p className="text-sm text-muted-foreground">
          {t("withdrawableMargin", {
            withdrawable: usd(equity.withdrawable),
            margin: usd(equity.totalMarginUsed),
          })}
        </p>
      )}
      {positions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noOpenPositions")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("coin")}</TableHead>
              <TableHead>{t("side")}</TableHead>
              <TableHead className="text-right">{t("size")}</TableHead>
              <TableHead className="text-right">{t("entry")}</TableHead>
              <TableHead className="text-right">{t("upnl")}</TableHead>
              <TableHead className="text-right">{t("lev")}</TableHead>
              <TableHead className="text-right">{t("liq")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((p) => (
              <TableRow key={p.coin}>
                <TableCell>{p.coin}</TableCell>
                <TableCell>{t(p.side)}</TableCell>
                <TableCell className="text-right">{Math.abs(p.size)}</TableCell>
                <TableCell className="text-right">{usd(p.entryPx)}</TableCell>
                <TableCell
                  className={`text-right ${p.unrealizedPnl < 0 ? "text-destructive" : ""}`}
                >
                  {usd(p.unrealizedPnl)}
                </TableCell>
                <TableCell className="text-right">
                  {p.leverage != null ? `${p.leverage}x` : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {p.liquidationPx != null ? usd(p.liquidationPx) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

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
      <div>
        <p className="text-sm text-muted-foreground">{t("totalValue")}</p>
        <p className="text-4xl font-bold">{usd(totalUsd)}</p>
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
        rows.map((row) => {
          const sections = toAccountSections(row.balances);
          return (
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
                {row.balances.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noSnapshot")}</p>
                ) : (
                  <div className="flex flex-col gap-6">
                    {sections.spot.length > 0 && <SpotTable rows={sections.spot} />}
                    {sections.defi.length > 0 && <DefiPositions groups={sections.defi} />}
                    {sections.perp && <PerpPositions view={sections.perp} />}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
