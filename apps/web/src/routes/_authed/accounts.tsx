import { cn, Fab, SharedLayoutBg } from "@folio/ui";
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
import { accountShare, activeAccountsTotal, shareLabel } from "../../lib/account-share";
import { sortActiveAccounts } from "../../lib/account-sort";
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

  // 活跃账户排序:未同步过(新加)置顶 → 其余按市值倒序;归档在末尾独立分区。
  const active = sortActiveAccounts(rows.filter((r) => r.archivedAt == null));
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
        <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
          {active.map((r) => (
            <button key={r.id} type="button" onClick={() => openRow(r)} className={ROW_CLASS}>
              <AccountRowContent row={r} total={total} />
            </button>
          ))}
        </SharedLayoutBg>
      )}

      {archived.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t("archivedSection", { count: archived.length })}
          </summary>
          <SharedLayoutBg className="mt-2" inset={0} pillClassName="rounded-xl bg-muted">
            {archived.map((r) => (
              <button key={r.id} type="button" onClick={() => openRow(r)} className={ROW_CLASS}>
                <AccountRowContent row={r} total={total} muted />
              </button>
            ))}
          </SharedLayoutBg>
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

// 行按钮 className:hover 高亮交给 SharedLayoutBg 的移动 pill 承载(行间无分隔线/边框),与代币行一致。
// group:让行内徽章/占比底衬能按 group-hover 响应 hover。padding 放内容层(见 AccountRowContent),
// 按钮本身不裁剪 —— 否则会切掉 SharedLayoutBg 的跨行滑块动画。
const ROW_CLASS = "group w-full rounded-xl text-left";

// 单个账户行内容:名称 + Platform 徽章 / 状态行 / 持有代币叠标;右侧市值 + 24h 增量(<ValueDelta> 全站统一,
// 与代币行同款)。缺凭据 → 不显增量(不再同步,无新鲜变化);占比只在抽屉里显示。
// 必须是单个 flex 容器 —— SharedLayoutBg 会把 <button> 的 children 塞进一个非 flex 的 z-10 div(见其实现),
// 故 flex 布局放这层内层 div,避免竖排(与 token-holdings RowContent 同约束)。
function AccountRowContent({
  row,
  total,
  muted,
}: {
  row: AccountRow;
  total: number;
  muted?: boolean;
}) {
  const status = accountSyncStatus(row, Date.now());
  const dayChange = row.needsCredentials ? null : aggregateDayChange(row.balances);
  const sharePct = accountShare(row.totalUsd, total) * 100;
  return (
    // padding + overflow-hidden 放这层(填满整行):占比大字只被行外框裁,不在内容盒内被切。
    <div
      className={cn(
        "relative flex w-full items-center justify-between gap-4 overflow-hidden rounded-xl px-3 py-3",
        muted && "opacity-60",
      )}
    >
      <span className="relative flex min-w-0 flex-col gap-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{row.label}</span>
          <ConnectorBadge
            connectorId={row.connectorId}
            className="transition-colors group-hover:bg-background group-focus-visible:bg-background"
          />
        </span>
        <AccountStatusLine status={status} takenAt={row.takenAt} />
        {/* 叠标位始终预留行高(min-h-6 = 叠标头像高),无现货可叠(纯 perp/DeFi 或未同步)的行也不塌矮,
            全列表行高一致。真 logo 的按-kind 填充(perp coin / DeFi 协议)待 #132 解绑后再接。 */}
        {!muted && (
          <span className="flex min-h-6 items-center">
            <TokenStack balances={row.balances} />
          </span>
        )}
      </span>
      {!muted && (
        <div className="relative shrink-0">
          {/* hover 底衬:超大占比数字倾斜、占满行高,锚在价值左缘(right-full)再右移一个 % 宽度 —— 只有末尾 %
              掖进价值下、前面数字全露出;-z-10 垫在名称/价值之下,中性淡色、仅 hover 浮现、不可点、不参与朗读。 */}
          {sharePct > 0 && (
            <span
              aria-hidden
              className="pointer-events-none absolute top-1/2 right-full -z-10 -translate-y-1/2 translate-x-[0.6em] -rotate-12 whitespace-nowrap font-bold text-8xl text-background/50 leading-none tracking-tighter opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              {shareLabel(sharePct)}%
            </span>
          )}
          <ValueDelta value={row.totalUsd} delta={dayChange?.delta} pct={dayChange?.pct} />
        </div>
      )}
    </div>
  );
}
