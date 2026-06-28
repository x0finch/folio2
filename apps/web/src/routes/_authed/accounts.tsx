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
import { useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { CredentialForm } from "../../components/credential-form";
import {
  createExchangeAccount,
  createManualAccount,
  createOnchainAccount,
  createPerpAccount,
  listMyAccounts,
} from "../../lib/server/accounts";
import { getCredentialSpecs } from "../../lib/server/credentials";
import {
  addAccountToGroup,
  createGroup,
  deleteGroup,
  getMyGroups,
  removeAccountFromGroup,
} from "../../lib/server/groups";
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
  loader: async () => {
    const [accounts, groups, credentialSpecs] = await Promise.all([
      listMyAccounts(),
      getMyGroups(),
      getCredentialSpecs(),
    ]);
    return { accounts, ...groups, credentialSpecs };
  },
  component: Accounts,
});

function Accounts() {
  const router = useRouter();
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const { accounts, groups, memberships, credentialSpecs } = Route.useLoaderData();
  // accountId → 所属 groupId 集合(渲染勾选状态)。
  const groupIdsByAccount = new Map<string, Set<string>>();
  for (const m of memberships) {
    const set = groupIdsByAccount.get(m.accountId) ?? new Set<string>();
    set.add(m.groupId);
    groupIdsByAccount.set(m.accountId, set);
  }

  // 分组管理表单
  const [groupName, setGroupName] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);

  // manual 录入(一账户一资产)
  const [label, setLabel] = useState("");
  const [mSymbol, setMSymbol] = useState("");
  const [mAmount, setMAmount] = useState("");
  const [mUsd, setMUsd] = useState("");
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
  // 该交易所是否需要 passphrase(由 provider 的 inputs 派生,不再硬编码 okx)。
  const exNeedsPassphrase = (credentialSpecs[exType] ?? []).some((i) => i.key === "passphrase");

  // 永续(perp)录入表单(只读地址)
  const [pType, setPType] = useState<PerpType>("perp_hyperliquid");
  const [pLabel, setPLabel] = useState("");
  const [pAddress, setPAddress] = useState("");
  const [pError, setPError] = useState<string | null>(null);
  const [pBusy, setPBusy] = useState(false);

  // 导入(P6.6):POST 文件到 /api/import(流式 NDJSON);成功后 invalidate 刷新列表。
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportMsg(null);
    setImportError(null);
    setImportBusy(true);
    try {
      const res = await fetch("/api/import", { method: "POST", body: file });
      if (!res.ok) throw new Error(await res.text());
      const { imported } = (await res.json()) as {
        imported: { accounts: number; groups: number; snapshots: number };
      };
      setImportMsg(
        t("imported", {
          accounts: imported.accounts,
          groups: imported.groups,
          snapshots: imported.snapshots,
        }),
      );
      await router.invalidate();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportBusy(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
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
    setBusy(true);
    try {
      await createManualAccount({
        data: { label, symbol: mSymbol, amount: mAmount, usdValue: mUsd },
      });
      setLabel("");
      setMSymbol("");
      setMAmount("");
      setMUsd("");
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    setGroupError(null);
    try {
      await createGroup({ data: { name: groupName } });
      setGroupName("");
      await router.invalidate();
    } catch (err) {
      setGroupError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDeleteGroup(groupId: string) {
    await deleteGroup({ data: { groupId } });
    await router.invalidate();
  }

  async function onToggleMembership(accountId: string, groupId: string, checked: boolean) {
    if (checked) await addAccountToGroup({ data: { accountId, groupId } });
    else await removeAccountFromGroup({ data: { accountId, groupId } });
    await router.invalidate();
  }

  async function onSync() {
    setSyncMsg(null);
    setBusy(true);
    try {
      const { results } = await triggerSync();
      const ok = results.filter((r) => r.ok).length;
      // 缺凭据账户(skipped)不算失败(导入待补录)。
      const failures = results.filter((r) => !r.ok && !r.skipped);
      const labelOf = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;
      let msg = t("synced", { count: ok });
      if (failures.length > 0) {
        const details = failures
          .map((f) => `${labelOf(f.accountId)}: ${f.error ?? "unknown error"}`)
          .join("; ");
        msg += ` ${t("syncFailed", { count: failures.length, details })}`;
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
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <Button onClick={onSync} disabled={busy || accounts.length === 0}>
          {t("syncNow")}
        </Button>
      </div>
      {syncMsg && <p className="text-sm text-muted-foreground">{syncMsg}</p>}

      {accounts.length === 0 ? (
        <p className="text-muted-foreground">{tc("noAccountsYet")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((a) => {
            const inGroups = groupIdsByAccount.get(a.id) ?? new Set<string>();
            const needsCreds = a.needsCredentials;
            return (
              <li key={a.id} className="flex flex-col gap-2 rounded-md border px-4 py-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    {a.label}
                    {needsCreds && (
                      <span className="rounded-sm bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                        {t("needsCredentials")}
                      </span>
                    )}
                  </span>
                  <span className="text-sm text-muted-foreground">{a.type}</span>
                </div>
                {needsCreds && (
                  <CredentialForm
                    accountId={a.id}
                    specs={credentialSpecs[a.type] ?? []}
                    hint={a.credsSafe}
                    onDone={() => router.invalidate()}
                  />
                )}
                {groups.length > 0 && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {groups.map((g) => (
                      <label
                        key={g.id}
                        className="flex items-center gap-1.5 text-sm text-muted-foreground"
                      >
                        <input
                          type="checkbox"
                          checked={inGroups.has(g.id)}
                          onChange={(e) => onToggleMembership(a.id, g.id, e.target.checked)}
                        />
                        {g.name}
                      </label>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("manageGroups")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreateGroup} className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="group-name">{t("newGroup")}</Label>
              <Input
                id="group-name"
                required
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder={t("groupNamePlaceholder")}
              />
            </div>
            <Button type="submit">{t("addGroup")}</Button>
          </form>
          {groupError && <p className="mt-2 text-sm text-destructive">{groupError}</p>}
          {groups.length > 0 && (
            <ul className="mt-4 flex flex-col gap-2">
              {groups.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between rounded-md border px-4 py-2"
                >
                  <span>{g.name}</span>
                  <Button variant="ghost" size="sm" onClick={() => onDeleteGroup(g.id)}>
                    {tc("delete")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("addManual")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="label">{t("label")}</Label>
              <Input
                id="label"
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("manualLabelPlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="m-symbol">{t("symbol")}</Label>
              <Input
                id="m-symbol"
                required
                value={mSymbol}
                onChange={(e) => setMSymbol(e.target.value)}
                placeholder="BTC"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="m-amount">{t("amount")}</Label>
              <Input
                id="m-amount"
                type="number"
                step="any"
                required
                value={mAmount}
                onChange={(e) => setMAmount(e.target.value)}
                placeholder="0.5"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="m-usd">{t("usdValue")}</Label>
              <Input
                id="m-usd"
                type="number"
                step="any"
                required
                value={mUsd}
                onChange={(e) => setMUsd(e.target.value)}
                placeholder="32000"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy} className="self-start">
              {t("createAccount")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("addOnchain")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreateOnchain} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="oc-chain">{t("chain")}</Label>
              <Select value={ocType} onValueChange={(v) => setOcType(v as OnchainType)}>
                <SelectTrigger id="oc-chain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ONCHAIN_TYPES.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="oc-label">{t("label")}</Label>
              <Input
                id="oc-label"
                required
                value={ocLabel}
                onChange={(e) => setOcLabel(e.target.value)}
                placeholder={t("walletLabelPlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="oc-address">{t("address")}</Label>
              <Input
                id="oc-address"
                required
                value={ocAddress}
                onChange={(e) => setOcAddress(e.target.value)}
                placeholder={
                  ocType === "onchain_evm" ? t("addrPlaceholderEvm") : t("addrPlaceholderGeneric")
                }
              />
              <p className="text-sm text-muted-foreground">{t("onchainHint")}</p>
            </div>
            {ocError && <p className="text-sm text-destructive">{ocError}</p>}
            <Button type="submit" disabled={ocBusy} className="self-start">
              {ocBusy ? tc("verifying") : t("addWallet")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("addExchange")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreateExchange} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="ex-exchange">{t("exchange")}</Label>
              <Select value={exType} onValueChange={(v) => setExType(v as ExchangeType)}>
                <SelectTrigger id="ex-exchange">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXCHANGE_TYPES.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ex-label">{t("label")}</Label>
              <Input
                id="ex-label"
                required
                value={exLabel}
                onChange={(e) => setExLabel(e.target.value)}
                placeholder={t("exchangeLabelPlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ex-key">{t("apiKey")}</Label>
              <Input
                id="ex-key"
                required
                value={exApiKey}
                onChange={(e) => setExApiKey(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ex-secret">{t("apiSecret")}</Label>
              <Input
                id="ex-secret"
                type="password"
                required
                value={exSecret}
                onChange={(e) => setExSecret(e.target.value)}
              />
            </div>
            {exNeedsPassphrase && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="ex-passphrase">{t("passphrase")}</Label>
                <Input
                  id="ex-passphrase"
                  type="password"
                  required
                  value={exPassphrase}
                  onChange={(e) => setExPassphrase(e.target.value)}
                />
              </div>
            )}
            <p className="text-sm text-muted-foreground">{t("exchangeHint")}</p>
            {exError && <p className="text-sm text-destructive">{exError}</p>}
            <Button type="submit" disabled={exBusy} className="self-start">
              {exBusy ? tc("verifying") : t("addExchangeBtn")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("addPerp")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreatePerp} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="p-venue">{t("venue")}</Label>
              <Select value={pType} onValueChange={(v) => setPType(v as PerpType)}>
                <SelectTrigger id="p-venue">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERP_TYPES.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="p-label">{t("label")}</Label>
              <Input
                id="p-label"
                required
                value={pLabel}
                onChange={(e) => setPLabel(e.target.value)}
                placeholder={t("perpLabelPlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="p-address">{t("address")}</Label>
              <Input
                id="p-address"
                required
                value={pAddress}
                onChange={(e) => setPAddress(e.target.value)}
                placeholder={t("addrPlaceholderEvm")}
              />
              <p className="text-sm text-muted-foreground">{t("perpHint")}</p>
            </div>
            {pError && <p className="text-sm text-destructive">{pError}</p>}
            <Button type="submit" disabled={pBusy} className="self-start">
              {pBusy ? tc("verifying") : t("addPerpBtn")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("importTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">{t("importHint")}</p>
            <input
              ref={importInputRef}
              type="file"
              accept=".ndjson,application/x-ndjson,application/json"
              className="hidden"
              onChange={onImportFile}
            />
            <Button
              type="button"
              variant="outline"
              disabled={importBusy}
              className="self-start"
              onClick={() => importInputRef.current?.click()}
            >
              {importBusy ? tc("verifying") : t("importBtn")}
            </Button>
            {importMsg && <p className="text-sm text-muted-foreground">{importMsg}</p>}
            {importError && <p className="text-sm text-destructive">{importError}</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
