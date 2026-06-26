import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@folio/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { createManualAccount, listMyAccounts } from "../../lib/server/accounts";
import { triggerSync } from "../../lib/server/sync";

export const Route = createFileRoute("/_authed/accounts")({
  loader: () => listMyAccounts(),
  component: Accounts,
});

interface HoldingRow {
  symbol: string;
  amount: string;
  usdValue: string;
}
const emptyRow = (): HoldingRow => ({ symbol: "", amount: "", usdValue: "" });

function Accounts() {
  const router = useRouter();
  const accounts = Route.useLoaderData();

  const [label, setLabel] = useState("");
  const [rows, setRows] = useState<HoldingRow[]>([emptyRow()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  function setRow(i: number, patch: Partial<HoldingRow>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const holdings = rows
      .filter((r) => r.symbol.trim())
      .map((r) => ({
        symbol: r.symbol.trim(),
        amount: Number(r.amount),
        usdValue: Number(r.usdValue),
      }));
    if (holdings.length === 0) {
      setError("Add at least one holding.");
      return;
    }
    setBusy(true);
    try {
      await createManualAccount({ data: { label, holdings } });
      setLabel("");
      setRows([emptyRow()]);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSync() {
    setSyncMsg(null);
    setBusy(true);
    try {
      const { results } = await triggerSync();
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      setSyncMsg(`Synced ${ok} account(s)${failed ? `, ${failed} failed` : ""}.`);
      await router.invalidate();
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Accounts</h1>
        <Button onClick={onSync} disabled={busy || accounts.length === 0}>
          Sync now
        </Button>
      </div>
      {syncMsg && <p className="text-sm text-muted-foreground">{syncMsg}</p>}

      {accounts.length === 0 ? (
        <p className="text-muted-foreground">No accounts yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between rounded-md border px-4 py-2"
            >
              <span>{a.label}</span>
              <span className="text-sm text-muted-foreground">{a.type}</span>
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Add manual account</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="label">Label</Label>
              <Input
                id="label"
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Cold storage"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>Holdings</Label>
              {rows.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional inputs
                <div key={i} className="flex gap-2">
                  <Input
                    aria-label="Symbol"
                    placeholder="BTC"
                    value={r.symbol}
                    onChange={(e) => setRow(i, { symbol: e.target.value })}
                  />
                  <Input
                    aria-label="Amount"
                    type="number"
                    step="any"
                    placeholder="0.5"
                    value={r.amount}
                    onChange={(e) => setRow(i, { amount: e.target.value })}
                  />
                  <Input
                    aria-label="USD value"
                    type="number"
                    step="any"
                    placeholder="32000"
                    value={r.usdValue}
                    onChange={(e) => setRow(i, { usdValue: e.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={rows.length === 1}
                    onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setRows((rs) => [...rs, emptyRow()])}
              >
                Add holding
              </Button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy} className="self-start">
              Create account
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
