import { cn, Fab } from "@folio/ui";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Plus } from "lucide-react";
import { useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { AccountDetailSheet, type AccountRow } from "../../components/account-detail-sheet";
import { AddAccountSheet } from "../../components/add-account-sheet";
import { ConnectorBadge } from "../../components/connector-badge";
import { AccountsSkeleton } from "../../components/skeletons";
import { TokenStack } from "../../components/token-stack";
import { ValueDelta } from "../../components/value-delta";
import { activeAccountsTotal } from "../../lib/account-share";
import { type AccountSyncStatus, accountSyncStatus } from "../../lib/account-sync-status";
import { aggregateDayChange } from "../../lib/day-value-change";
import { useStalePriceRefresh } from "../../lib/hooks/use-stale-price-refresh";
import { listMyAccounts } from "../../lib/server/accounts";
import { getCredentialSpecs } from "../../lib/server/credentials";
import { getMyAccountHoldings } from "../../lib/server/overview";

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
        connectorId: a.connectorId,
        archivedAt: a.archivedAt,
        totalUsd: ov?.totalUsd ?? 0,
        takenAt: ov?.takenAt ?? null,
        balances: ov?.balances ?? [],
        note: ov?.note,
        needsCredentials: a.needsCredentials,
        credsSafe: a.credsSafe,
      };
    });
    return { rows, credentialSpecs, pricesStale: overview.pricesStale };
  },
  pendingComponent: AccountsSkeleton,
  component: Accounts,
});

function Accounts() {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const { rows, credentialSpecs, pricesStale } = Route.useLoaderData();
  useStalePriceRefresh(pricesStale); // SWR:先展示旧价,后台刷新后 invalidate 二次展示

  const active = rows.filter((r) => r.archivedAt == null);
  const archived = rows.filter((r) => r.archivedAt != null);
  const total = activeAccountsTotal(rows); // 抽屉占比分母(顶部不显总额)

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
      <h1 className="font-bold text-2xl">{t("accountCount", { count: active.length })}</h1>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">{tc("noAccountsYet")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {active.map((r) => (
            <li key={r.id}>
              <AccountRowButton row={r} onClick={() => openRow(r)} />
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
                <AccountRowButton row={r} muted onClick={() => openRow(r)} />
              </li>
            ))}
          </ul>
        </details>
      )}

      <AccountDetailSheet
        account={selected}
        total={total}
        specs={selected ? (credentialSpecs[selected.connectorId] ?? []) : []}
        open={open}
        onOpenChange={setOpen}
      />

      <AddAccountSheet
        triggerRender={<Fab position="bottom-right" icon={<Plus />} aria-label={t("addAccount")} />}
      />
    </div>
  );
}

// 状态行(名称下方一条纯文本,按态染色):缺凭据 / 陈旧 → --warn 警示色 + 前置 ⚠;新鲜 / 从未同步 → muted。
// 陈旧仍显"同步于 {when}"(带告警),缺凭据显"缺凭据"。派生走 accountSyncStatus 纯函数。
function AccountStatusLine({
  status,
  takenAt,
}: {
  status: AccountSyncStatus;
  takenAt: number | null;
}) {
  const t = useTranslations("Accounts");
  const format = useFormatter();
  const warn = status === "needsCreds" || status === "stale";
  // needsCreds/never 无 takenAt(never 定义即无快照)→ 显固定文案;fresh/stale 有 takenAt → 显同步时刻。
  const text =
    status === "needsCreds"
      ? t("needsCredentials")
      : takenAt != null
        ? t("lastSyncedAt", { when: format.relativeTime(new Date(takenAt)) })
        : t("neverSynced");
  return (
    <span
      className={cn(
        "flex items-center gap-1 text-xs",
        warn ? "text-warn" : "text-muted-foreground",
      )}
    >
      {warn && (
        <>
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          <span className="sr-only">{t("syncWarning")}</span>
        </>
      )}
      {text}
    </span>
  );
}

// 单个账户行:整行可点 → 打开详情侧栏。名称 + Platform 徽章 / 状态行 / 持有代币叠标;右侧市值 + 24h 增量
// (<ValueDelta> 全站统一,与代币行同款)。缺凭据 → 不显增量(不再同步,无新鲜变化);占比只在抽屉里显示。
function AccountRowButton({
  row,
  muted,
  onClick,
}: {
  row: AccountRow;
  muted?: boolean;
  onClick: () => void;
}) {
  const status = accountSyncStatus(row, Date.now());
  const dayChange = row.needsCredentials ? null : aggregateDayChange(row.balances);
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
          <ConnectorBadge connectorId={row.connectorId} />
        </span>
        <AccountStatusLine status={status} takenAt={row.takenAt} />
        {!muted && <TokenStack balances={row.balances} />}
      </span>
      {!muted && <ValueDelta value={row.totalUsd} delta={dayChange?.delta} pct={dayChange?.pct} />}
    </button>
  );
}
