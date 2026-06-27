import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@folio/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  createExchangeAccount,
  createManualAccount,
  createOnchainAccount,
  createPerpAccount,
  listMyAccounts,
} from "../../lib/server/accounts";
import { triggerSync } from "../../lib/server/sync";

// 可录入的链上账户类型 → 展示名(EVM 走 zerion;其余走 coinstats)。
const ONCHAIN_TYPES = [
  { value: "onchain_evm", label: "Ethereum / EVM" },
  { value: "onchain_solana", label: "Solana" },
  { value: "onchain_sui", label: "Sui" },
  { value: "onchain_cosmos", label: "Cosmos" },
] as const;
type OnchainType = (typeof ONCHAIN_TYPES)[number]["value"];

// 可录入的交易所(有 provider 的);okx 需 passphrase。
const EXCHANGE_TYPES = [
  { value: "exchange_binance", label: "Binance" },
  { value: "exchange_okx", label: "OKX" },
] as const;
type ExchangeType = (typeof EXCHANGE_TYPES)[number]["value"];

// 可录入的永续 DEX(有 provider 的);地址=EVM 地址。derive/extended 就绪再加。
const PERP_TYPES = [{ value: "perp_hyperliquid", label: "Hyperliquid" }] as const;
type PerpType = (typeof PERP_TYPES)[number]["value"];

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

  // on-chain 录入表单(链可选)
  const [ocType, setOcType] = useState<OnchainType>("onchain_evm");
  const [ocLabel, setOcLabel] = useState("");
  const [ocAddress, setOcAddress] = useState("");
  const [ocError, setOcError] = useState<string | null>(null);
  const [ocBusy, setOcBusy] = useState(false);

  // 交易所(CEX)录入表单
  const [exType, setExType] = useState<ExchangeType>("exchange_binance");
  const [exLabel, setExLabel] = useState("");
  const [exApiKey, setExApiKey] = useState("");
  const [exSecret, setExSecret] = useState("");
  const [exPassphrase, setExPassphrase] = useState("");
  const [exError, setExError] = useState<string | null>(null);
  const [exBusy, setExBusy] = useState(false);

  // 永续(perp)录入表单(只读地址)
  const [pType, setPType] = useState<PerpType>("perp_hyperliquid");
  const [pLabel, setPLabel] = useState("");
  const [pAddress, setPAddress] = useState("");
  const [pError, setPError] = useState<string | null>(null);
  const [pBusy, setPBusy] = useState(false);

  function setRow(i: number, patch: Partial<HoldingRow>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function onCreateExchange(e: React.FormEvent) {
    e.preventDefault();
    setExError(null);
    setExBusy(true);
    try {
      await createExchangeAccount({
        data: {
          type: exType,
          label: exLabel,
          apiKey: exApiKey,
          secret: exSecret,
          passphrase: exPassphrase || undefined,
        },
      });
      setExLabel("");
      setExApiKey("");
      setExSecret("");
      setExPassphrase("");
      await router.invalidate();
    } catch (err) {
      setExError(err instanceof Error ? err.message : String(err));
    } finally {
      setExBusy(false);
    }
  }

  async function onCreatePerp(e: React.FormEvent) {
    e.preventDefault();
    setPError(null);
    setPBusy(true);
    try {
      await createPerpAccount({ data: { type: pType, label: pLabel, address: pAddress } });
      setPLabel("");
      setPAddress("");
      await router.invalidate();
    } catch (err) {
      setPError(err instanceof Error ? err.message : String(err));
    } finally {
      setPBusy(false);
    }
  }

  async function onCreateOnchain(e: React.FormEvent) {
    e.preventDefault();
    setOcError(null);
    setOcBusy(true);
    try {
      await createOnchainAccount({ data: { type: ocType, label: ocLabel, address: ocAddress } });
      setOcLabel("");
      setOcAddress("");
      await router.invalidate();
    } catch (err) {
      setOcError(err instanceof Error ? err.message : String(err));
    } finally {
      setOcBusy(false);
    }
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
      const failures = results.filter((r) => !r.ok);
      const labelOf = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;
      let msg = `Synced ${ok} account(s).`;
      if (failures.length > 0) {
        msg += ` ${failures.length} failed — ${failures
          .map((f) => `${labelOf(f.accountId)}: ${f.error ?? "unknown error"}`)
          .join("; ")}`;
      }
      setSyncMsg(msg);
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

      <Card>
        <CardHeader>
          <CardTitle>Add on-chain wallet</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreateOnchain} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="oc-chain">Chain</Label>
              <Select value={ocType} onValueChange={(v) => setOcType(v as OnchainType)}>
                <SelectTrigger id="oc-chain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ONCHAIN_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="oc-label">Label</Label>
              <Input
                id="oc-label"
                required
                value={ocLabel}
                onChange={(e) => setOcLabel(e.target.value)}
                placeholder="e.g. Main wallet"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="oc-address">Address</Label>
              <Input
                id="oc-address"
                required
                value={ocAddress}
                onChange={(e) => setOcAddress(e.target.value)}
                placeholder={ocType === "onchain_evm" ? "0x…" : "wallet address"}
              />
              <p className="text-sm text-muted-foreground">
                Read-only. Tokens (and DeFi on EVM) are fetched by the provider for the chosen
                chain.
              </p>
            </div>
            {ocError && <p className="text-sm text-destructive">{ocError}</p>}
            <Button type="submit" disabled={ocBusy} className="self-start">
              {ocBusy ? "Verifying…" : "Add wallet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add exchange account</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreateExchange} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="ex-exchange">Exchange</Label>
              <Select value={exType} onValueChange={(v) => setExType(v as ExchangeType)}>
                <SelectTrigger id="ex-exchange">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXCHANGE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ex-label">Label</Label>
              <Input
                id="ex-label"
                required
                value={exLabel}
                onChange={(e) => setExLabel(e.target.value)}
                placeholder="e.g. Binance main"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ex-key">API key</Label>
              <Input
                id="ex-key"
                required
                value={exApiKey}
                onChange={(e) => setExApiKey(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ex-secret">API secret</Label>
              <Input
                id="ex-secret"
                type="password"
                required
                value={exSecret}
                onChange={(e) => setExSecret(e.target.value)}
              />
            </div>
            {exType === "exchange_okx" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="ex-passphrase">Passphrase</Label>
                <Input
                  id="ex-passphrase"
                  type="password"
                  required
                  value={exPassphrase}
                  onChange={(e) => setExPassphrase(e.target.value)}
                />
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              Use a <strong>read-only</strong> API key (no trade/withdraw). Stored encrypted; never
              shown again.
            </p>
            {exError && <p className="text-sm text-destructive">{exError}</p>}
            <Button type="submit" disabled={exBusy} className="self-start">
              {exBusy ? "Verifying…" : "Add exchange"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add perp account</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreatePerp} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="p-venue">Venue</Label>
              <Select value={pType} onValueChange={(v) => setPType(v as PerpType)}>
                <SelectTrigger id="p-venue">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERP_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="p-label">Label</Label>
              <Input
                id="p-label"
                required
                value={pLabel}
                onChange={(e) => setPLabel(e.target.value)}
                placeholder="e.g. HL main"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="p-address">Address</Label>
              <Input
                id="p-address"
                required
                value={pAddress}
                onChange={(e) => setPAddress(e.target.value)}
                placeholder="0x…"
              />
              <p className="text-sm text-muted-foreground">
                Read-only. Perp positions and margin are fetched by the provider.
              </p>
            </div>
            {pError && <p className="text-sm text-destructive">{pError}</p>}
            <Button type="submit" disabled={pBusy} className="self-start">
              {pBusy ? "Verifying…" : "Add perp account"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
