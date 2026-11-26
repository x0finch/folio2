import type { AccountTagLink, Tag } from "@folio/db";
import {
  BottomSheet,
  Button,
  cn,
  Drawer,
  MorphingModal,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  toast,
  useMediaQuery,
} from "@folio/ui";
import {
  AlertTriangle,
  Archive,
  FolderInput,
  MoreVertical,
  RefreshCw,
  Tag as TagIcon,
  Trash2,
} from "@folio/ui/icons";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { AccountTagsModal } from "@/components/account-tags-modal";
import { AmountTicker } from "@/components/amount-ticker";
import { ConnectorBadge } from "@/components/connector-badge";
import { EditableName } from "@/components/editable-name";
import { AccountHoldingsCards } from "@/components/holdings-cards";
import { IconButton } from "@/components/icon-button";
import { ManualTokensPanel } from "@/components/manual-tokens-panel";
import { Portal } from "@/components/portal";
import { PortfolioPickerModal } from "@/components/portfolio-picker-modal";
import { type Range, RangeTabs, rangeSince } from "@/components/range-tabs";
import { Sensitive } from "@/components/sensitive";
import { TagBadges } from "@/components/tag-badges";
import { signedUsd } from "@/lib/core/format-number";
import { buildAccountValueHistory, type HistoryPoint } from "@/lib/core/history";
import { isManual } from "@/lib/core/manual";
import type { Gain } from "@/lib/core/portfolio";
import { useChartScrub } from "@/lib/hooks/use-chart-scrub";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { useHoverPopover } from "@/lib/hooks/use-hover-popover";
import { useRelativeSyncedAt } from "@/lib/hooks/use-relative-synced-at";
import { syncAccountAndWait } from "@/lib/queries/account-sync";
import { accountHistoryQuery } from "@/lib/queries/accounts";
import { invalidateFor } from "@/lib/queries/refresh";
import { archiveAccount, removeAccount, renameAccount } from "@/lib/server/accounts";
import { TrendPanel } from "@/routes/_authed/-home/hero/trend-panel";
import { deltaTone, GainSkeleton, NO_VALUE } from "@/routes/_authed/-home/holdings/value-delta";
import { type AccountRow, accountShare, shareLabel } from "./list-rows";

// Account detail drawer: desktop Drawer / mobile BottomSheet around one <DetailBody>. The header
// is a value-history chart backdrop with window switch and a ⋯ menu; holdings reuse the home components.
export function AccountDetailSheet({
  account,
  total,
  allTags,
  tagLinks,
  gainPending = false,
  open,
  onOpenChange,
  onComplete,
}: {
  account: AccountRow | null;
  total: number; // active-accounts total: denominator of the share in the drawer header
  allTags: Tag[]; // all tag definitions (the tag modal filters by the account's portfolio)
  tagLinks: AccountTagLink[]; // all account -> tag links (attached state + per-tag counts)
  /** 24h PnL still loading: header and spot rows show a small skeleton. */
  gainPending?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (account: AccountRow) => void; // opens the add-account modal in credential re-entry mode
}) {
  const isDesktop = useMediaQuery("(min-width: 640px)");
  // key={account.id} remounts, resetting rename/confirm/range local state on account switch.
  const body = account && (
    <DetailBody
      key={account.id}
      account={account}
      total={total}
      allTags={allTags}
      tagLinks={tagLinks}
      gainPending={gainPending}
      onClose={() => onOpenChange(false)}
      onComplete={() => onComplete(account)}
    />
  );

  if (isDesktop) {
    return (
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        side="right"
        ariaLabel={account?.label}
        className="w-full overflow-y-auto p-6 sm:max-w-lg"
      >
        {body}
      </Drawer>
    );
  }
  // No title: the body header already renders the account name.
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} snapPoints={[0.6, 0.92]}>
      {body}
    </BottomSheet>
  );
}

// Seal date format: year, month, day, no time (archiving is day-granular).
const SEALED_DATE = { year: "2-digit", month: "short", day: "numeric" } as const;

const menuItemClass =
  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50";

function DetailBody({
  account,
  total,
  allTags,
  tagLinks,
  gainPending,
  onClose,
  onComplete,
}: {
  account: AccountRow;
  total: number;
  allTags: Tag[];
  tagLinks: AccountTagLink[];
  gainPending: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const t = useTranslations("Accounts");
  const format = useFormatter();
  // The drawer mounts late, so it is exposed to the clock's one-tick settle delay.
  const syncedAt = useRelativeSyncedAt();
  // Chart scrub reading.
  const scrub = useChartScrub();
  const writes = useAccountSheetWrites(account, onClose);

  const sealedAt = account.archivedAt;
  const archived = sealedAt != null;
  // The header's 24h delta and share are omitted for archived accounts: value is frozen at seal
  // time while 24h change is live, and the share denominator excludes archived accounts (shares
  // would exceed 100%). Missing credentials omit the delta likewise. "Shouldn't have the number"
  // omits the block; "should but can't compute" renders `—` (see -home/holdings/value-delta). Font
  // size differs here, hence not reusing <ValueDelta>.
  const hasDayChange = !(account.needsCredentials || archived);
  const dayChange = hasDayChange ? account.gain24h : undefined;
  const sharePct = accountShare(account.totalUsd, total) * 100;

  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moving, setMoving] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  // Data for the tag modal: the portfolio's tags + this account's attached ids + per-tag counts.
  const portfolioTags = useMemo(
    () => allTags.filter((tg) => tg.portfolioId === account.portfolioId),
    [allTags, account.portfolioId],
  );
  const attachedTagIds = useMemo(
    () => tagLinks.filter((l) => l.accountId === account.id).map((l) => l.tagId),
    [tagLinks, account.id],
  );
  const tagAccountCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of tagLinks) counts[l.tagId] = (counts[l.tagId] ?? 0) + 1;
    return counts;
  }, [tagLinks]);

  const [range, setRange] = useState<Range>("30d");
  const historyQuery = useQuery({
    ...accountHistoryQuery({
      accountId: account.id,
      range,
      // Archived accounts anchor the window at the seal time: anchored at now, a year-old
      // archive has no points in the default 30D window and the chart wouldn't render.
      since: rangeSince(range, sealedAt ?? Date.now()),
      connectorId: account.connectorId,
    }),
    placeholderData: keepPreviousData,
  });
  const raw = historyQuery.data;
  // The curve is drawn in the browser from the raw snapshot points in the window.
  const series = useMemo(
    () =>
      raw == null ? [] : buildAccountValueHistory(raw.rows, raw.live, { sampled: raw.sampled }),
    [raw],
  );

  // Archived first, then manual: archived data is frozen, so show the static seal date, not a
  // relative time that would grow like a broken sync.
  const lastSynced =
    sealedAt != null
      ? t("sealedAt", { when: format.dateTime(new Date(sealedAt), SEALED_DATE) })
      : isManual(account.connectorId)
        ? t("liveValue")
        : account.takenAt
          ? t("lastSyncedAt", { when: syncedAt(account.takenAt) })
          : t("neverSynced");

  return (
    <>
      {/* Header: chart backdrop, window switch bottom-right, ⋯ menu top-right, text over it. Fixed
          min-h-44 so the async chart doesn't resize the list. */}
      <div className="relative min-h-44">
        <TrendPanel series={series} loading={historyQuery.isPending} onActive={scrub.onActive} />
        <div className="absolute right-0 bottom-0 z-10">
          <RangeTabs value={range} onChange={setRange} />
        </div>
        <div className="relative flex flex-col gap-2">
          {/* Inline rename via EditableName; pr-10 leaves room for the ⋯ button. */}
          <EditableName
            value={account.label}
            editing={renaming}
            onEditingChange={setRenaming}
            onSave={async (name) => {
              await writes.renameMut.mutateAsync(name);
            }}
            displayClassName="font-semibold text-lg"
            className="pr-10"
          >
            <ConnectorBadge connectorId={account.connectorId} />
            {archived && (
              <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground text-xs">
                {t("archivedBadge")}
              </span>
            )}
            {/* Tags sit beside the connector badge, display-only; editing is in the ⋯ menu. */}
            <TagBadges tags={account.tags} />
          </EditableName>
          <div>
            <SheetHeaderValue
              valuesReady={account.valuesReady}
              totalUsd={account.totalUsd}
              hasDayChange={hasDayChange}
              gainPending={gainPending}
              dayChange={dayChange}
              scrubbed={scrub.point}
              scrubLabel={scrub.label}
            />
          </div>
          {account.needsCredentials && (
            <div className="flex items-center gap-2 text-warn text-xs">
              <AlertTriangle className="shrink-0" aria-hidden />
              <button
                type="button"
                onClick={onComplete}
                className="rounded-md underline-offset-2 outline-none transition-colors hover:underline focus-visible:ring-1 focus-visible:ring-warn"
              >
                {t("completePrompt")}
              </button>
            </div>
          )}
        </div>
        <SheetOverflowMenu
          connectorId={account.connectorId}
          archived={archived}
          syncPending={writes.syncMut.isPending}
          archivePending={writes.archiveMut.isPending}
          onSync={() => writes.syncMut.mutate()}
          onArchive={() => writes.archiveMut.mutate()}
          onTags={() => setTagsOpen(true)}
          onMove={() => setMoving(true)}
          onDelete={() => setConfirmDelete(true)}
        />
      </div>

      <p className="mt-2 min-w-0 truncate text-muted-foreground text-xs">
        {account.valuesReady &&
          !archived &&
          sharePct > 0 &&
          `${t("shareOfTotal", { pct: shareLabel(sharePct) })} · `}
        {account.valuesReady ||
        account.needsCredentials ||
        archived ||
        isManual(account.connectorId) ? (
          lastSynced
        ) : (
          <Skeleton className="inline-block h-3 w-24" />
        )}
      </p>

      <ConfirmDeleteModal
        open={confirmDelete}
        pending={writes.deleteMut.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => writes.deleteMut.mutate()}
      />

      <PortfolioPickerModal
        mode="move"
        accountId={account.id}
        currentPortfolioId={account.portfolioId}
        open={moving}
        onClose={() => setMoving(false)}
      />

      <AccountTagsModal
        accountId={account.id}
        portfolioId={account.portfolioId}
        portfolioTags={portfolioTags}
        attachedTagIds={attachedTagIds}
        tagAccountCounts={tagAccountCounts}
        open={tagsOpen}
        onClose={() => setTagsOpen(false)}
      />

      <SheetHoldings account={account} gainPending={gainPending} />
    </>
  );
}

function useAccountSheetWrites(account: AccountRow, onClose: () => void) {
  const t = useTranslations("Accounts");
  const queryClient = useQueryClient();
  const archived = account.archivedAt != null;
  const refresh = () => invalidateFor(queryClient, "account.write");
  const refreshArchive = () => invalidateFor(queryClient, "account.archive");

  const syncMut = useMutation({
    // Covers trigger plus waiting for the queued job: `syncPending` keeps the menu item disabled throughout.
    mutationFn: () => syncAccountAndWait(queryClient, account.id),
    onSuccess: async (r) => {
      if (r.ok) toast.success(t("synced", { count: 1 }));
      // Missing credentials is a skip the user can fix, so it gets a toast instead of staying silent.
      else if (r.skipped) {
        if (r.skipReason === "missing-credentials") toast.message(t("syncNeedsCredentials"));
      } else toast.error(r.error ?? t("syncGenericError"));
      await invalidateFor(queryClient, "account.sync");
    },
    onError: () => toast.error(t("syncGenericError")),
  });
  const archiveMut = useMutation({
    mutationFn: () => archiveAccount({ data: { accountId: account.id, archived: !archived } }),
    onSuccess: refreshArchive,
    onError: () => toast.error(t("actionFailed")),
  });
  const deleteMut = useMutation({
    mutationFn: () => removeAccount({ data: { accountId: account.id } }),
    onSuccess: async () => {
      onClose();
      await refresh();
    },
    onError: () => toast.error(t("actionFailed")),
  });
  // mutateAsync so a failure rejects: EditableName keeps edit mode when onSave throws.
  const renameMut = useMutation({
    mutationFn: (label: string) => renameAccount({ data: { accountId: account.id, label } }),
    onSuccess: refresh,
    onError: () => toast.error(t("actionFailed")),
  });

  return { syncMut, archiveMut, deleteMut, renameMut };
}

function SheetOverflowMenu({
  connectorId,
  archived,
  syncPending,
  archivePending,
  onSync,
  onArchive,
  onTags,
  onMove,
  onDelete,
}: {
  connectorId: AccountRow["connectorId"];
  archived: boolean;
  syncPending: boolean;
  archivePending: boolean;
  onSync: () => void;
  onArchive: () => void;
  onTags: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const tp = useTranslations("Portfolio");
  const tt = useTranslations("Tags");
  const menuPop = useHoverPopover();

  return (
    <div className="absolute top-0 right-0 z-20">
      <Popover
        trigger="hover"
        side={menuPop.side}
        align="end"
        panelRadius={12}
        onOpenChange={menuPop.onOpenChange}
        className={menuPop.rootClassName}
      >
        <PopoverTrigger>
          <IconButton ref={menuPop.measureRef} aria-label={t("moreActions")}>
            <MoreVertical />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent>
          <div className="flex w-40 flex-col gap-1">
            {!isManual(connectorId) && (
              <button
                type="button"
                className={menuItemClass}
                disabled={archived || syncPending}
                onClick={onSync}
              >
                <RefreshCw className="shrink-0" />
                {t("syncThis")}
              </button>
            )}
            <button
              type="button"
              className={menuItemClass}
              disabled={archivePending}
              onClick={onArchive}
            >
              <Archive className="shrink-0" />
              {archived ? t("unarchive") : t("archive")}
            </button>
            <button type="button" className={menuItemClass} onClick={onTags}>
              <TagIcon className="shrink-0" />
              {tt("menuAction")}
            </button>
            <button type="button" className={menuItemClass} onClick={onMove}>
              <FolderInput className="shrink-0" />
              {tp("moveTo")}
            </button>
            <button
              type="button"
              className={cn(menuItemClass, "text-destructive hover:text-destructive")}
              onClick={onDelete}
            >
              <Trash2 className="shrink-0" />
              {tc("delete")}
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ConfirmDeleteModal({
  open,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const isDesktop = useMediaQuery("(min-width: 640px)");

  return (
    <Portal>
      <MorphingModal
        viewId={open ? "delete" : null}
        onClose={onClose}
        placement={isDesktop ? "center" : "bottom"}
        className="max-w-sm"
      >
        <div className="flex flex-col gap-4">
          <p className="text-foreground text-sm">{t("deleteConfirm")}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button size="sm" variant="destructive" onClick={onConfirm} disabled={pending}>
              {pending ? tc("verifying") : t("deleteConfirmBtn")}
            </Button>
          </div>
        </div>
      </MorphingModal>
    </Portal>
  );
}

function SheetHeaderValue({
  valuesReady,
  totalUsd,
  hasDayChange,
  gainPending,
  dayChange,
  scrubbed,
  scrubLabel,
}: {
  valuesReady: boolean;
  totalUsd: number;
  hasDayChange: boolean;
  gainPending: boolean;
  dayChange: Gain | null | undefined;
  /** The point being scrubbed on the chart; `null` = not scrubbing, show the live value. */
  scrubbed: HistoryPoint | null;
  scrubLabel: string | null;
}) {
  const usd = useDisplayValue();
  if (!valuesReady) {
    return (
      <div className="flex flex-col gap-1">
        <Skeleton className="h-9 w-36" />
        <GainSkeleton />
      </div>
    );
  }
  // While scrubbing, the point's value replaces the live one and the 24h row shows that moment's time.
  return (
    <>
      {/* Rolling and integer/decimal split use AmountTicker (shared with hero and token drawer). */}
      <AmountTicker
        value={scrubbed ? scrubbed.total : totalUsd}
        scrubbing={!!scrubbed}
        className="font-bold text-3xl"
        fractionClassName="font-bold text-muted-foreground text-xl tabular-nums"
      />
      {scrubLabel ? (
        <div className="mt-1 text-muted-foreground text-sm tabular-nums">{scrubLabel}</div>
      ) : null}
      {!scrubbed && hasDayChange && (
        <SheetHeaderGain gainPending={gainPending} dayChange={dayChange} usd={usd} />
      )}
    </>
  );
}

function SheetHeaderGain({
  gainPending,
  dayChange,
  usd,
}: {
  gainPending: boolean;
  dayChange: Gain | null | undefined;
  usd: (n: number) => string;
}) {
  if (gainPending) {
    return (
      <div className="mt-1">
        <GainSkeleton />
      </div>
    );
  }
  if (dayChange == null) {
    return <div className={cn("mt-1 text-sm tabular-nums", deltaTone(null))}>{NO_VALUE}</div>;
  }
  return (
    <div className={cn("mt-1 text-sm tabular-nums", deltaTone(dayChange.amount))}>
      {/* Masks the PnL amount, not the percentage. */}
      <Sensitive>{signedUsd(usd, dayChange.amount)}</Sensitive>
      {dayChange.pct != null ? ` ${Math.abs(dayChange.pct).toFixed(2)}%` : ""}
    </div>
  );
}

function SheetHoldings({ account, gainPending }: { account: AccountRow; gainPending: boolean }) {
  if (!account.valuesReady) {
    return (
      <div className="mt-6 flex flex-col gap-3">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }
  if (isManual(account.connectorId)) {
    return (
      <div className="mt-6">
        <ManualTokensPanel
          accountId={account.id}
          balances={account.balances}
          gainPending={gainPending}
        />
      </div>
    );
  }
  return (
    <div className="mt-6">
      <AccountHoldingsCards
        balances={account.balances}
        accountNote={account.note}
        gainPending={gainPending}
      />
    </div>
  );
}
