import type { ManualActivity } from "@folio/db";
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
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { AddAccountSheet } from "../../components/add-account-sheet";
import { CredentialForm } from "../../components/credential-form";
import { listMyAccounts } from "../../lib/server/accounts";
import { getCredentialSpecs } from "../../lib/server/credentials";
import {
  addAccountToGroup,
  createGroup,
  deleteGroup,
  getMyGroups,
  removeAccountFromGroup,
} from "../../lib/server/groups";
import {
  addManualActivity,
  deleteManualActivity,
  listManualActivity,
} from "../../lib/server/manual-activity";
import { triggerSync } from "../../lib/server/sync";

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

  // 账户录入统一走 AddAccountSheet 侧栏(见 components/add-account-sheet.tsx);本页只留同步/分组/活动/导入。
  const [busy, setBusy] = useState(false); // 同步中(onSync)
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

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
        <div className="flex gap-2">
          <AddAccountSheet />
          <Button onClick={onSync} disabled={busy || accounts.length === 0}>
            {t("syncNow")}
          </Button>
        </div>
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
                {a.type === "manual" && <ManualActivityPanel accountId={a.id} />}
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

// manual 账户的活动面板(P7.4.1):列出 add/reduce/set 活动 + 录入/删除。自取数据(client fetch)。
// 改动后 router.invalidate() 刷新总览(数量已物化进 creds.amount)。
function ManualActivityPanel({ accountId }: { accountId: string }) {
  const t = useTranslations("Activity");
  const router = useRouter();
  const [items, setItems] = useState<ManualActivity[]>([]);
  const [kind, setKind] = useState<"add" | "reduce" | "set">("add");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setItems(await listManualActivity({ data: { accountId } }));
  };
  useEffect(() => {
    let alive = true;
    listManualActivity({ data: { accountId } })
      .then((rows) => alive && setItems(rows))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [accountId]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await addManualActivity({
        data: { accountId, kind, amount: Number(amount), note: note || undefined },
      });
      setAmount("");
      setNote("");
      await reload();
      await router.invalidate(); // 数量变 → 刷新总览
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    await deleteManualActivity({ data: { accountId, id } });
    await reload();
    await router.invalidate();
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-2">
      <p className="text-xs font-medium text-muted-foreground">{t("title")}</p>
      {items.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-2">
              <span>
                <span className="capitalize">{t(it.kind)}</span> {it.amount}
                {it.note ? <span className="text-muted-foreground"> · {it.note}</span> : null}
              </span>
              <button
                type="button"
                onClick={() => onDelete(it.id)}
                className="text-xs text-muted-foreground hover:text-destructive"
              >
                {t("delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={onAdd} className="flex flex-wrap items-end gap-2">
        <Select value={kind} onValueChange={(v) => setKind(v as "add" | "reduce" | "set")}>
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="add">{t("add")}</SelectItem>
            <SelectItem value="reduce">{t("reduce")}</SelectItem>
            <SelectItem value="set">{t("set")}</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="number"
          step="any"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={t("amountPlaceholder")}
          className="w-32"
        />
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("notePlaceholder")}
          className="w-40"
        />
        <Button type="submit" size="sm" disabled={busy}>
          {t("record")}
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
