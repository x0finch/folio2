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
import { getMyOverview } from "../../lib/server/overview";

export const Route = createFileRoute("/_authed/")({
  loader: () => getMyOverview(),
  component: Overview,
});

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

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
              {row.balances.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No snapshot yet — sync from the Accounts page.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Asset</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {row.balances.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell>{b.symbol}</TableCell>
                        <TableCell className="text-right">{b.amount}</TableCell>
                        <TableCell className="text-right">{usd(b.usdValue)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
