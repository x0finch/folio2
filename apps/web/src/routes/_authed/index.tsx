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
import { type PerpView, toPerpView } from "../../lib/perp";
import { getMyOverview } from "../../lib/server/overview";

export const Route = createFileRoute("/_authed/")({
  loader: () => getMyOverview(),
  component: Overview,
});

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

// 一个账户的余额行(现货表只用 symbol/amount/usdValue;perp 的 metaJson 由 toPerpView 解析)。
interface OverviewBalance {
  id: string;
  symbol: string;
  amount: number;
  usdValue: number;
}

// 现货/CEX/manual:数量 + 美元价值。
function SpotTable({ balances }: { balances: OverviewBalance[] }) {
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
        {balances.map((b) => (
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
  const { rows, totalUsd } = Route.useLoaderData();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-muted-foreground">Total value</p>
        <p className="text-4xl font-bold">{usd(totalUsd)}</p>
      </div>

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
          // 类别 = type 前缀(契约里约定的访问方式);perp 走专用展示,其余走现货表。
          const isPerp = row.account.type.split("_")[0] === "perp";
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
                ) : isPerp ? (
                  <PerpPositions view={toPerpView(row.balances)} />
                ) : (
                  <SpotTable balances={row.balances} />
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
