import { Fab } from "@folio/ui";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { AccountDetailSheet, type AccountRow } from "../../components/account-detail-sheet";
import { AccountTypeBadge } from "../../components/account-type-badge";
import { AddAccountSheet } from "../../components/add-account-sheet";
import { useUsd } from "../../components/holdings-sections";
import { SyncButton } from "../../components/sync-button";
import { TokenStack } from "../../components/token-stack";
import { listMyAccounts } from "../../lib/server/accounts";
import { getCredentialSpecs } from "../../lib/server/credentials";
import { getMyAccountHoldings } from "../../lib/server/overview";
import { useStalePriceRefresh } from "../../lib/use-stale-price-refresh";

export const Route = createFileRoute("/_authed/accounts")({
  loader: async () => {
    // 合并两源:getMyOverview 给活跃账户的市值/上次同步/持仓;listMyAccounts 给全部账户(含归档)的
    // 凭据态 + archivedAt。归档账户不在 overview.rows(见 overview.ts 过滤)→ 其 value/holdings 为空。
    const [overview, accounts, credentialSpecs] = await Promise.all([
      getMyAccountHoldings(),
      listMyAccounts(),
      getCredentialSpecs(),
    ]);
    const byId = new Map(overview.rows.map((r) => [r.account.id, r]));
    const rows: AccountRow[] = accounts.map((a) => {
      const ov = byId.get(a.id);
      return {
        id: a.id,
        label: a.label,
        type: a.type,
        archivedAt: a.archivedAt,
        totalUsd: ov?.totalUsd ?? 0,
        takenAt: ov?.takenAt ?? null,
        balances: ov?.balances ?? [],
        needsCredentials: a.needsCredentials,
        credsSafe: a.credsSafe,
      };
    });
    return { rows, credentialSpecs, pricesStale: overview.pricesStale };
  },
  component: Accounts,
});

function Accounts() {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const usd = useUsd();
  const { rows, credentialSpecs, pricesStale } = Route.useLoaderData();
  useStalePriceRefresh(pricesStale); // SWR:先展示旧价,后台刷新后 invalidate 二次展示

  const active = rows.filter((r) => r.archivedAt == null);
  const archived = rows.filter((r) => r.archivedAt != null);
  const lastSyncedAt = active.reduce((m, r) => Math.max(m, r.takenAt ?? 0), 0) || null;

  // 详情侧栏:存 id 而非行对象 —— invalidate 后从新 rows 派生,侧栏内容随刷新自动更新(归档态等)。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;
  const openRow = (r: AccountRow) => {
    setSelectedId(r.id);
    setOpen(true);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{t("accountCount", { count: active.length })}</h1>
        <SyncButton
          accounts={active.map((r) => ({ id: r.id, label: r.label }))}
          lastSyncedAt={lastSyncedAt}
        />
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">{tc("noAccountsYet")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {active.map((r) => (
            <li key={r.id}>
              <AccountRowButton row={r} usd={usd} onClick={() => openRow(r)} />
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <details className="rounded-md border px-4 py-2">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t("archivedSection", { count: archived.length })}
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {archived.map((r) => (
              <li key={r.id}>
                <AccountRowButton row={r} usd={usd} muted onClick={() => openRow(r)} />
              </li>
            ))}
          </ul>
        </details>
      )}

      <AccountDetailSheet
        account={selected}
        specs={selected ? (credentialSpecs[selected.type] ?? []) : []}
        open={open}
        onOpenChange={setOpen}
      />

      <AddAccountSheet
        triggerRender={<Fab position="bottom-right" icon={<Plus />} aria-label={t("addAccount")} />}
      />
    </div>
  );
}

// 单个账户行:整行可点 → 打开详情侧栏。左上 名称 + 类型徽章(+ 缺凭据);左下 持有代币层叠图标;右 市值。
function AccountRowButton({
  row,
  usd,
  muted,
  onClick,
}: {
  row: AccountRow;
  usd: (n: number) => string;
  muted?: boolean;
  onClick: () => void;
}) {
  const t = useTranslations("Accounts");
  const format = useFormatter();
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-4 rounded-md border px-4 py-3 text-left transition-colors hover:bg-muted/50 ${
        muted ? "opacity-60" : ""
      }`}
    >
      <span className="flex min-w-0 flex-col gap-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{row.label}</span>
          <AccountTypeBadge type={row.type} />
          {row.needsCredentials && (
            <span className="rounded-sm bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
              {t("needsCredentials")}
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          {row.takenAt
            ? t("lastSyncedAt", { when: format.relativeTime(new Date(row.takenAt)) })
            : t("neverSynced")}
        </span>
        {!muted && <TokenStack balances={row.balances} />}
      </span>
      {!muted && <span className="shrink-0 font-medium">{usd(row.totalUsd)}</span>}
    </button>
  );
}
