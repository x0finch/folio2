import type { ConnectorId } from "@folio/connectors";
import { cn, SharedLayoutBg } from "@folio/ui";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Plus } from "lucide-react";
import { useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { AccountDetailSheet, type AccountRow } from "../../components/account-detail-sheet";
import { AddAccountModal, type CompleteTarget } from "../../components/add-account-modal";
import { ConnectorBadge } from "../../components/connector-badge";
import { HeaderSync } from "../../components/header-sync";
import { AccountsSkeleton } from "../../components/skeletons";
import { TokenStack } from "../../components/token-stack";
import { ValueDelta } from "../../components/value-delta";
import { accountShare, activeAccountsTotal, shareLabel } from "../../lib/account-share";
import { sortActiveAccounts } from "../../lib/account-sort";
import { type AccountSyncStatus, accountSyncStatus } from "../../lib/account-sync-status";
import { accountIdsInView } from "../../lib/accounts-in-view";
import { aggregateDayChange } from "../../lib/day-value-change";
import { usePortfolio } from "../../lib/hooks/use-portfolio";
import { useStalePriceRefresh } from "../../lib/hooks/use-stale-price-refresh";
import { isManual } from "../../lib/manual-connector";
import { listAccounts } from "../../lib/server/accounts";
import { listAccountHoldings, listPortfolioMemberships } from "../../lib/server/portfolio";

export const Route = createFileRoute("/_authed/accounts")({
  loader: async () => {
    // 合并两源:listAccountHoldings 给活跃账户的市值/上次同步/持仓;listAccounts 给全部账户(含归档)的
    // 凭据态 + archivedAt。归档账户不在 overview.rows(见 portfolio.ts 过滤)→ 其 value/holdings 为空。
    // memberships:按选中 Portfolio 客户端过滤账户列表用(账户页已加载全部账户,过滤在客户端即可)。
    const [overview, accounts, memberships] = await Promise.all([
      listAccountHoldings(),
      listAccounts(),
      listPortfolioMemberships(),
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
    return { rows, memberships, pricesStale: overview.pricesStale };
  },
  pendingComponent: AccountsSkeleton,
  component: Accounts,
});

function Accounts() {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const { rows: allRows, memberships, pricesStale } = Route.useLoaderData();
  const { selectedId: selectedPortfolioId, defaultId } = usePortfolio();
  useStalePriceRefresh(pricesStale); // SWR:先展示旧价,后台刷新后 invalidate 二次展示

  // 账户页 scope 到选中 Portfolio(ADR 0033):只显归属选中的账户(含其归档成员)。归属过滤在客户端
  // (归档无关的成员集),切 Portfolio 即时重筛、无需重拉。选择器即作用域,账户页不设单独 tab。
  const memberIds = accountIdsInView(
    allRows.map((r) => r.id),
    memberships,
    selectedPortfolioId,
    defaultId,
  );
  const rows = allRows.filter((r) => memberIds.has(r.id));

  // 活跃账户排序:未同步过(新加)置顶 → 其余按市值倒序;归档在末尾独立分区。
  const active = sortActiveAccounts(rows.filter((r) => r.archivedAt == null));
  const archived = rows.filter((r) => r.archivedAt != null);
  const total = activeAccountsTotal(rows); // 抽屉占比分母(顶部不显总额)

  // 详情侧栏:存 id 而非行对象 —— invalidate 后从新 rows 派生,侧栏内容随刷新自动更新(归档态等)。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // 补录目标(A3):列表/详情点补录 icon → 开加账户 modal 的补录模式(见 AddAccountModal completeFor)。
  const [completeTarget, setCompleteTarget] = useState<CompleteTarget | null>(null);
  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;
  const openRow = (r: AccountRow) => {
    setSelectedId(r.id);
    setOpen(true);
  };
  const startComplete = (a: AccountRow) =>
    setCompleteTarget({ accountId: a.id, connectorId: a.connectorId, credsSafe: a.credsSafe });

  return (
    <div className="flex flex-col gap-6">
      {/* 页头右上角同步入口:账户页额外把「添加账户」融进 + 段(见 SyncStatus.ActionShell),modal 由本页持有。 */}
      <HeaderSync
        action={{ icon: <Plus />, label: t("addAccount"), onClick: () => setAddOpen(true) }}
      />
      <AddAccountModal
        open={addOpen}
        onOpenChange={setAddOpen}
        completeFor={completeTarget}
        onCompleteClose={() => setCompleteTarget(null)}
      />
      <h1 className="font-bold text-2xl">{t("accountCount", { count: active.length })}</h1>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">{tc("noAccountsYet")}</p>
      ) : (
        <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
          {active.map((r) => (
            <button key={r.id} type="button" onClick={() => openRow(r)} className={ROW_CLASS}>
              <AccountRowContent row={r} total={total} onComplete={() => startComplete(r)} />
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
        open={open}
        onOpenChange={setOpen}
        onComplete={startComplete}
      />
    </div>
  );
}

// 状态行(名称下方一条纯文本,按态染色):缺凭据 / 陈旧 → --warn 警示色 + 前置 ⚠;新鲜 / 从未同步 → muted。
// 缺凭据 → 显可点击的"补填凭据以同步"提示(文案即入口,点开补录 modal);陈旧显"同步于 {when}"。派生走 accountSyncStatus。
function AccountStatusLine({
  status,
  takenAt,
  connectorId,
  onComplete,
}: {
  status: AccountSyncStatus;
  takenAt: number | null;
  connectorId: ConnectorId;
  onComplete?: () => void; // 缺凭据时:点提示文案开补录 modal(A3),不冒泡到行的打开详情
}) {
  const t = useTranslations("Accounts");
  const format = useFormatter();
  const warn = status === "needsCreds" || status === "stale";
  const needsCreds = status === "needsCreds";
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
      {/* 缺凭据 + 可补录 → 可点击提示文案(文案本身即入口);行是 <button>,故用 role=button span +
          stopPropagation 避免按钮套按钮 / 误触打开详情。归档(无 onComplete)→ 纯文案。 */}
      {needsCreds && onComplete ? (
        // biome-ignore lint/a11y/useSemanticElements: 行本身是 <button>,不能再嵌套 <button>(无效 HTML),故用 role=button span
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onComplete();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onComplete();
            }
          }}
          className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-1 focus-visible:ring-warn"
        >
          {t("completePrompt")}
        </span>
      ) : needsCreds ? (
        t("completePrompt")
      ) : isManual(connectorId) ? (
        // manual 不同步,当下值实时由 creds 现造(ADR 0018)→ 显「实时」而非同步时间。
        t("liveValue")
      ) : takenAt != null ? (
        t("lastSyncedAt", { when: format.relativeTime(new Date(takenAt)) })
      ) : (
        t("neverSynced")
      )}
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
  onComplete,
}: {
  row: AccountRow;
  total: number;
  muted?: boolean;
  onComplete?: () => void; // 活跃缺凭据行:行内补录按钮(归档行不传)
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
        <AccountStatusLine
          status={status}
          takenAt={row.takenAt}
          connectorId={row.connectorId}
          onComplete={onComplete}
        />
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
              className="pointer-events-none absolute top-1/2 right-full -z-10 -translate-y-1/2 translate-x-14 -rotate-12 whitespace-nowrap font-bold text-8xl text-background/50 leading-none tracking-tighter opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
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
