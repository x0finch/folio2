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
import { PortfolioChart } from "../../components/portfolio-chart";
import { type DefiGroup, type SpotRow, toAccountSections } from "../../lib/account-view";
import type { PerpView } from "../../lib/perp";
import { getPortfolioHistory } from "../../lib/server/history";
import { getMyOverview } from "../../lib/server/overview";

export const Route = createFileRoute("/_authed/")({
  loader: async () => {
    const [overview, history] = await Promise.all([getMyOverview(), getPortfolioHistory()]);
    return { ...overview, series: history.series };
  },
  component: Overview,
});

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

// 现货/CEX/manual:数量 + 美元价值。
function SpotTable({ rows }: { rows: SpotRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Asset</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Value</TableHead>
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
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.protocol} className="flex flex-col gap-2">
          <p className="text-sm font-medium">{g.protocol}</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Value</TableHead>
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
  const { equity, positions } = view;
  return (
    <div className="flex flex-col gap-3">
      {equity && (
        <p className="text-sm text-muted-foreground">
          Withdrawable {usd(equity.withdrawable)} · Margin used {usd(equity.totalMarginUsed)}
        </p>
      )}
      {positions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open positions.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Coin</TableHead>
              <TableHead>Side</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Entry</TableHead>
              <TableHead className="text-right">uPnL</TableHead>
              <TableHead className="text-right">Lev.</TableHead>
              <TableHead className="text-right">Liq.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((p) => (
              <TableRow key={p.coin}>
                <TableCell>{p.coin}</TableCell>
                <TableCell className="capitalize">{p.side}</TableCell>
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

function Overview() {
  const { rows, totalUsd, series } = Route.useLoaderData();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-muted-foreground">Total value</p>
        <p className="text-4xl font-bold">{usd(totalUsd)}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Portfolio value</CardTitle>
        </CardHeader>
        <CardContent>
          {series.length < 2 ? (
            <p className="text-sm text-muted-foreground">
              Not enough history yet — sync a few times to see the trend.
            </p>
          ) : (
            <PortfolioChart series={series} />
          )}
        </CardContent>
      </Card>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          No accounts yet.{" "}
          <Link to="/accounts" className="underline">
            Add one
          </Link>
          .
        </p>
      ) : (
        rows.map((row) => {
          // 一个账户卡 = 按 kind 分区组合(净值不变量保证卡标题净值 = 各 usdValue 之和)。
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
                  <p className="text-sm text-muted-foreground">
                    No snapshot yet — sync from the Accounts page.
                  </p>
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
