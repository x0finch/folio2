import type { ConnectorId } from "@folio/connectors";
import { cn, SharedLayoutBg, Skeleton } from "@folio/ui";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { AlertTriangle, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { AvatarStack } from "../../../components/avatar-stack";
import { ConnectorBadge } from "../../../components/connector-badge";
import { QueryBoundary } from "../../../components/query-boundary";
import { TagBadges } from "../../../components/tag-badges";
import { accountIdsInView } from "../../../lib/core/accounts-in-view";
import { isManual } from "../../../lib/core/manual";
import { usePortfolio } from "../../../lib/hooks/use-portfolio";
import { useStalePriceRefresh } from "../../../lib/hooks/use-stale-price-refresh";
import {
  accountGain24hQuery,
  accountHoldingsQuery,
  accountListQuery,
} from "../../../lib/queries/accounts";
import { accountKeys, portfolioKeys } from "../../../lib/queries/keys";
import { portfolioMembershipsQuery } from "../../../lib/queries/portfolio";
import { accountTagLinksQuery, tagListQuery } from "../../../lib/queries/tags";
import { HeaderSync } from "../-home/header-sync";
import { GainSkeleton, ValueDelta } from "../-home/holdings/value-delta";
import { AccountDetailSheet } from "./account-detail-sheet";
import { AddAccountModal, type CompleteTarget } from "./add-account-modal";
import { attachAccountGains } from "./list-attach-gains";
import {
  type AccountRow,
  type AccountSyncStatus,
  accountShare,
  accountSyncStatus,
  activeAccountsTotal,
  buildAccountRows,
  shareLabel,
  sortActiveAccounts,
} from "./list-rows";
import { accountStackItems } from "./list-stack-items";

const accountsRoute = getRouteApi("/_authed/accounts");

const LIST_RESET_KEY = JSON.stringify([accountKeys.list(), portfolioKeys.memberships()]);

export function Accounts() {
  const t = useTranslations("Accounts");
  const [addOpen, setAddOpen] = useState(false);
  const [completeTarget, setCompleteTarget] = useState<CompleteTarget | null>(null);
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
      <QueryBoundary
        resetKey={`list:${LIST_RESET_KEY}`}
        pending={<ListSkeleton />}
        failed={<ListFailed />}
      >
        <AccountsList onComplete={startComplete} />
      </QueryBoundary>
    </div>
  );
}

function ListFailed() {
  const t = useTranslations("Overview");
  return <p className="py-12 text-center text-muted-foreground text-sm">{t("loadFailed")}</p>;
}

const ROWS_4 = ["r1", "r2", "r3", "r4"];

function ListSkeleton() {
  return (
    <>
      <Skeleton className="h-8 w-40" />
      <div className="flex flex-col">
        {ROWS_4.map((k) => (
          <div key={k} className="flex items-center justify-between gap-4 px-3 py-3">
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
              <span className="min-h-6" />
            </div>
            <div className="flex flex-col items-end gap-1">
              <Skeleton className="h-4 w-20" />
              <GainSkeleton />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function AccountsList({ onComplete }: { onComplete: (a: AccountRow) => void }) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const { data: accounts } = useSuspenseQuery(accountListQuery());
  const { data: memberships } = useSuspenseQuery(portfolioMembershipsQuery());
  const holdingsQuery = useQuery(accountHoldingsQuery());
  const gainQuery = useQuery(accountGain24hQuery());
  const { data: allTags = [] } = useQuery(tagListQuery());
  const { data: tagLinks = [] } = useQuery(accountTagLinksQuery());
  const holdings = holdingsQuery.data;
  const allRows = useMemo(
    () => buildAccountRows({ accounts, holdings, memberships, allTags, tagLinks }),
    [accounts, holdings, memberships, allTags, tagLinks],
  );
  const { selectedId: selectedPortfolioId, defaultId } = usePortfolio();
  useStalePriceRefresh(holdings?.pricesStale, !gainQuery.isPending);

  // 账户页 scope 到选中 Portfolio(ADR 0033):只显归属选中的账户(含其归档成员)。归属过滤在客户端
  // (归档无关的成员集),切 Portfolio 即时重筛、无需重拉。选择器即作用域,账户页不设单独 tab。
  const memberIds = accountIdsInView(
    allRows.map((r) => r.id),
    memberships,
    selectedPortfolioId,
    defaultId,
  );
  const rows = useMemo(
    () =>
      attachAccountGains(
        allRows.filter((r) => memberIds.has(r.id)),
        gainQuery.data,
        gainQuery.isError,
      ),
    [allRows, memberIds, gainQuery.data, gainQuery.isError],
  );

  const activeUnsorted = rows.filter((r) => r.archivedAt == null);
  // 金额没到时别按假 0 排 —— 否则数字一到整表重排,看着像名单自己在跳。
  const active = activeUnsorted.every((r) => r.valuesReady)
    ? sortActiveAccounts(activeUnsorted)
    : activeUnsorted;
  const archived = rows.filter((r) => r.archivedAt != null);
  const total = activeAccountsTotal(rows);

  const { account: selectedId } = accountsRoute.useSearch();
  const navigate = accountsRoute.useNavigate();
  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;
  const setAccount = (id: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, account: id }), replace: true, resetScroll: false });
  const openRow = (r: AccountRow) => setAccount(r.id);

  return (
    <>
      <h1 className="font-bold text-2xl">{t("accountCount", { count: active.length })}</h1>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">{tc("noAccountsYet")}</p>
      ) : (
        <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
          {active.map((r) => (
            <button key={r.id} type="button" onClick={() => openRow(r)} className={ROW_CLASS}>
              <AccountRowContent
                row={r}
                total={total}
                gainPending={gainQuery.isPending}
                onComplete={() => onComplete(r)}
              />
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
                <AccountRowContent row={r} total={total} gainPending={gainQuery.isPending} muted />
              </button>
            ))}
          </SharedLayoutBg>
        </details>
      )}

      <AccountDetailSheet
        account={selected}
        total={total}
        allTags={allTags}
        tagLinks={tagLinks}
        gainPending={gainQuery.isPending}
        open={selected != null}
        onOpenChange={(o) => {
          if (!o) setAccount(undefined);
        }}
        onComplete={onComplete}
      />
    </>
  );
}

const SEALED_DATE = { year: "2-digit", month: "short", day: "numeric" } as const;

function AccountStatusLine({
  status,
  takenAt,
  connectorId,
  archivedAt,
  onComplete,
}: {
  status: AccountSyncStatus;
  takenAt: number | null;
  connectorId: ConnectorId;
  archivedAt: number | null;
  onComplete?: () => void;
}) {
  const t = useTranslations("Accounts");
  const format = useFormatter();
  const archived = archivedAt != null;
  const warn = !archived && (status === "needsCreds" || status === "stale");
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
      {archived ? (
        t("sealedAt", { when: format.dateTime(new Date(archivedAt), SEALED_DATE) })
      ) : needsCreds && onComplete ? (
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
        t("liveValue")
      ) : takenAt != null ? (
        t("lastSyncedAt", { when: format.relativeTime(new Date(takenAt)) })
      ) : (
        t("neverSynced")
      )}
    </span>
  );
}

const ROW_CLASS = "group w-full rounded-xl text-left";

// 必须是单个 flex 容器 —— SharedLayoutBg 会把 <button> 的 children 塞进一个非 flex 的 z-10 div,
// 故 flex 布局放这层内层,避免竖排。归档行只调暗,不抽市值与叠标(#437)。
function AccountRowContent({
  row,
  total,
  muted,
  gainPending,
  onComplete,
}: {
  row: AccountRow;
  total: number;
  muted?: boolean;
  gainPending: boolean;
  onComplete?: () => void;
}) {
  const status = accountSyncStatus(row, Date.now());
  const archived = row.archivedAt != null;
  const showGain = !(row.needsCredentials || archived);
  const dayChange = showGain ? row.gain24h : undefined;
  const sharePct = accountShare(row.totalUsd, total) * 100;
  // 缺凭据 / 归档封存日 / manual「实时」名单里已经能确定,立刻写;其余同步时间等持仓到。
  const statusKnown =
    row.needsCredentials || archived || isManual(row.connectorId) || row.valuesReady;
  return (
    <div
      className={cn(
        "relative flex w-full items-center justify-between gap-4 overflow-hidden rounded-xl px-3 py-3",
        muted && "opacity-60",
      )}
    >
      <span className="relative flex min-w-0 flex-col gap-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium">{row.label}</span>
          <ConnectorBadge
            connectorId={row.connectorId}
            className="shrink-0 transition-colors group-hover:bg-background group-focus-visible:bg-background"
          />
          {row.tags.length > 0 && <TagBadges tags={row.tags} max={3} />}
        </span>
        {statusKnown ? (
          <AccountStatusLine
            status={status}
            takenAt={row.takenAt}
            connectorId={row.connectorId}
            archivedAt={row.archivedAt}
            onComplete={onComplete}
          />
        ) : (
          <Skeleton className="h-3 w-20" />
        )}
        <span className="flex min-h-6 items-center">
          <AvatarStack
            items={row.valuesReady ? accountStackItems(row.balances) : []}
            max={5}
            size="md"
          />
        </span>
      </span>
      <div className="relative shrink-0">
        {row.valuesReady && !archived && sharePct > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-full -z-10 -translate-y-1/2 translate-x-14 -rotate-12 whitespace-nowrap font-bold text-8xl text-background/50 leading-none tracking-tighter opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            {shareLabel(sharePct)}%
          </span>
        )}
        {!row.valuesReady ? (
          <div className="flex flex-col items-end gap-1">
            <Skeleton className="h-4 w-20" />
            <GainSkeleton />
          </div>
        ) : (
          <ValueDelta
            value={row.totalUsd}
            delta={showGain ? (dayChange?.amount ?? null) : undefined}
            pct={dayChange?.pct}
            loading={showGain && gainPending}
          />
        )}
      </div>
    </div>
  );
}
