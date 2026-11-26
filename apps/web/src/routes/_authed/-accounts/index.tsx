import type { ConnectorId } from "@folio/connectors";
import { cn, SharedLayoutBg, Skeleton } from "@folio/ui";
import { AlertTriangle, Plus } from "@folio/ui/icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { AvatarStack } from "@/components/avatar-stack";
import { ConnectorBadge } from "@/components/connector-badge";
import { StaggerReveal } from "@/components/page-switcher/stagger-reveal";
import { QueryBoundary } from "@/components/query-boundary";
import { TagBadges } from "@/components/tag-badges";
import { isManual } from "@/lib/core/manual";
import { type AccountSyncStatus, accountSyncStatus } from "@/lib/core/sync-status";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { useRelativeSyncedAt } from "@/lib/hooks/use-relative-synced-at";
import { useAccountHoldingsView } from "@/lib/queries/account-holdings-compose";
import { accountListQuery } from "@/lib/queries/accounts";
import { accountKeys, portfolioKeys } from "@/lib/queries/keys";
import { accountHoldingsSnapshotTimes } from "@/lib/queries/snapshots";
import {
  type AccountTagLinks,
  accountTagLinksQuery,
  type TagList,
  tagListQuery,
} from "@/lib/queries/tags";
import { HeaderSync } from "@/routes/_authed/-home/header-sync";
import { GainSkeleton, ValueDelta } from "@/routes/_authed/-home/holdings/value-delta";
import { AccountDetailSheet } from "./account-detail-sheet";
import { AddAccountModal, type CompleteTarget } from "./add-account-modal";
import {
  type AccountRow,
  accountShare,
  activeAccountsTotal,
  buildAccountRows,
  shareLabel,
  sortActiveAccounts,
} from "./list-rows";
import { accountStackItems } from "./list-stack-items";

const accountsRoute = getRouteApi("/_authed/{-$page}");

// Membership ships with the account rows, so the account list is the only reset key.
const LIST_RESET_KEY = (portfolioId: string) => JSON.stringify(accountKeys.list(portfolioId));

export function Accounts() {
  const t = useTranslations("Accounts");
  const { selectedId } = usePortfolio();
  const [addOpen, setAddOpen] = useState(false);
  const [completeTarget, setCompleteTarget] = useState<CompleteTarget | null>(null);
  const startComplete = (a: AccountRow) =>
    setCompleteTarget({
      accountId: a.id,
      connectorId: a.connectorId,
      credsSafe: a.credsSafe,
      missingCreds: a.missingCreds,
    });

  return (
    <>
      {/* Outside the reveal container: the absolute sync bar jumps ~24px inside a transformed
          layer (see StaggerReveal); the modal is an overlay. */}
      <HeaderSync
        action={{ icon: <Plus />, label: t("addAccount"), onClick: () => setAddOpen(true) }}
      />
      <AddAccountModal
        open={addOpen}
        onOpenChange={setAddOpen}
        completeFor={completeTarget}
        onCompleteClose={() => setCompleteTarget(null)}
      />
      {/* The list sections arrive as one child, so spacing moves to `itemClassName`. */}
      <StaggerReveal className="flex flex-col" itemClassName="flex flex-col gap-6">
        <QueryBoundary
          resetKey={`list:${LIST_RESET_KEY(selectedId)}`}
          pending={<ListSkeleton />}
          failed={<ListFailed />}
        >
          <AccountsList onComplete={startComplete} />
        </QueryBoundary>
      </StaggerReveal>
    </>
  );
}

function ListFailed() {
  const t = useTranslations("Overview");
  return <p className="py-12 text-center text-muted-foreground text-sm">{t("loadFailed")}</p>;
}

const ROWS_4 = ["r1", "r2", "r3", "r4"];

function ListSkeleton() {
  return (
    <div className="flex flex-col">
      {ROWS_4.map((k) => (
        <div key={k} className="flex items-center justify-between gap-4 px-4 py-6">
          <div className="flex flex-col gap-2">
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
  );
}

// Rows are awaited by the outer boundary; balances and tags suspend in their own boundary (see
// the note in ../-home/hero/index.tsx on why not `useQuery` + `isPending`).
function AccountsList({ onComplete }: { onComplete: (a: AccountRow) => void }) {
  // Already filtered to the selected portfolio server-side.
  const { selectedId } = usePortfolio();
  const { data: accounts } = useSuspenseQuery(accountListQuery(selectedId));
  const { anchor } = accountHoldingsSnapshotTimes();
  return (
    <QueryBoundary
      resetKey={`list-values:${JSON.stringify([accountKeys.list(selectedId), portfolioKeys.snapshots(selectedId, anchor)])}`}
      pending={<AccountsListBody accounts={accounts} onComplete={onComplete} />}
      failed={<AccountsListBody accounts={accounts} onComplete={onComplete} />}
    >
      <AccountsListReady accounts={accounts} onComplete={onComplete} />
    </QueryBoundary>
  );
}

function AccountsListReady({
  accounts,
  onComplete,
}: {
  accounts: RowSources["accounts"];
  onComplete: (a: AccountRow) => void;
}) {
  const { selectedId } = usePortfolio();
  const holdings = useAccountHoldingsView(
    selectedId,
    accounts.map((a) => ({ id: a.id, label: a.label, archivedAt: a.archivedAt })),
  );
  const { data: allTags } = useSuspenseQuery(tagListQuery(selectedId));
  const { data: tagLinks } = useSuspenseQuery(accountTagLinksQuery(selectedId));
  return (
    <AccountsListBody
      accounts={accounts}
      onComplete={onComplete}
      holdings={holdings}
      allTags={allTags}
      tagLinks={tagLinks}
    />
  );
}

// Derived from the callee so it can't drift.
type RowSources = Parameters<typeof buildAccountRows>[0];

function AccountsListBody({
  accounts,
  onComplete,
  holdings,
  allTags = [],
  tagLinks = [],
}: {
  accounts: RowSources["accounts"];
  onComplete: (a: AccountRow) => void;
  holdings?: RowSources["holdings"];
  // Not from RowSources: the list needs only an id + name projection, the sheet needs full rows.
  allTags?: TagList;
  tagLinks?: AccountTagLinks;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const rows = useMemo(
    () => buildAccountRows({ accounts, holdings, allTags, tagLinks }),
    [accounts, holdings, allTags, tagLinks],
  );

  const allRows = rows;
  const activeUnsorted = rows.filter((r) => r.archivedAt == null);
  // Don't sort by placeholder zeros, or the whole list reorders when amounts arrive.
  const active = activeUnsorted.every((r) => r.valuesReady)
    ? sortActiveAccounts(activeUnsorted)
    : activeUnsorted;
  const archived = rows.filter((r) => r.archivedAt != null);
  const total = activeAccountsTotal(rows);

  // `focus` stays in the URL as a one-shot command (the sync panel writes it cross-page); it's read
  // once then cleared. The selected account is plain state.
  const { focus } = accountsRoute.useSearch();
  const navigate = accountsRoute.useNavigate();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;
  const openRow = (r: AccountRow) => setSelectedId(r.id);

  // Scroll a row from the header sync panel into view and flash it (without selecting it). Wait
  // until rows exist, or "still loading" would read as "not in this view".
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || allRows.length === 0) return;
    const clearFocus = () =>
      navigate({
        search: (prev) => ({ ...prev, focus: undefined }),
        replace: true,
        resetScroll: false,
      });
    const el = document.getElementById(accountRowDomId(focus));
    if (el) {
      // Archived rows live in a collapsed <details>; without a layout box scrollIntoView is a no-op.
      el.closest("details")?.setAttribute("open", "");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      setFlashId(focus);
    }
    clearFocus();
  }, [focus, allRows, navigate]);

  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);

  return (
    <>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{tc("noAccountsYet")}</p>
      ) : (
        <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
          {active.map((r) => (
            <button
              key={r.id}
              id={accountRowDomId(r.id)}
              type="button"
              onClick={() => openRow(r)}
              className={cn(ROW_CLASS, flashId === r.id && FLASH_CLASS)}
            >
              <AccountRowContent row={r} total={total} onComplete={() => onComplete(r)} />
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
        allTags={allTags}
        tagLinks={tagLinks}
        open={selected != null}
        onOpenChange={(o) => {
          if (!o) setSelectedId(undefined);
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
  const syncedAt = useRelativeSyncedAt();
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
          <AlertTriangle className="shrink-0" aria-hidden />
          <span className="sr-only">{t("syncWarning")}</span>
        </>
      )}
      {archived ? (
        t("sealedAt", { when: format.dateTime(new Date(archivedAt), SEALED_DATE) })
      ) : needsCreds && onComplete ? (
        // biome-ignore lint/a11y/useSemanticElements: the row is already a <button>; nesting another is invalid HTML
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
          className="rounded-md underline-offset-2 outline-none hover:underline focus-visible:ring-1 focus-visible:ring-warn"
        >
          {t("completePrompt")}
        </span>
      ) : needsCreds ? (
        t("completePrompt")
      ) : isManual(connectorId) ? (
        t("liveValue")
      ) : takenAt != null ? (
        t("lastSyncedAt", { when: syncedAt(takenAt) })
      ) : (
        t("neverSynced")
      )}
    </span>
  );
}

const ROW_CLASS = "group w-full rounded-xl text-left";

// A ring, not a background: SharedLayoutBg's hover/selected pill already uses the background.
const FLASH_CLASS = "ring-2 ring-ring";
const FLASH_MS = 1200;

const accountRowDomId = (accountId: string) => `account-row-${accountId}`;

// Must be a single flex container: SharedLayoutBg wraps <button> children in a non-flex div.
function AccountRowContent({
  row,
  total,
  muted,
  onComplete,
}: {
  row: AccountRow;
  total: number;
  muted?: boolean;
  onComplete?: () => void;
}) {
  const status = accountSyncStatus(row, Date.now());
  const archived = row.archivedAt != null;
  const showGain = !(row.needsCredentials || archived);
  const dayChange = showGain ? row.gain24h : undefined;
  const sharePct = accountShare(row.totalUsd, total) * 100;
  // Known from the list alone; the rest waits for holdings.
  const statusKnown =
    row.needsCredentials || archived || isManual(row.connectorId) || row.valuesReady;
  return (
    <div
      className={cn(
        "relative flex w-full items-center justify-between gap-4 overflow-hidden rounded-xl px-4 py-6",
        muted && "opacity-60",
      )}
    >
      <span className="relative flex min-w-0 flex-col gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium">{row.label}</span>
          <ConnectorBadge connectorId={row.connectorId} className="shrink-0" />
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
          />
        )}
      </div>
    </div>
  );
}
