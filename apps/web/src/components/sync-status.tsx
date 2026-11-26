import type { ConnectorId } from "@folio/connectors";
import { cn, Popover, PopoverContent, PopoverTrigger, useHoverCapable } from "@folio/ui";
import { RefreshCw } from "@folio/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { forwardRef, type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import { connectorLabelFallback } from "@/lib/core/logo";
import type { SyncAttentionSource, SyncStatusSummary } from "@/lib/core/sync-status";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { useRelativeSyncedAt } from "@/lib/hooks/use-relative-synced-at";
import { type AutoSyncOption, isRoundBusy, useSyncRound } from "@/lib/hooks/use-sync-round";
import { connectorCatalogQuery } from "@/lib/queries/connectors";
import type { SyncRoundFailure, SyncRoundView } from "@/lib/server/sync/status";
import { IconButton } from "./icon-button";

// One Popover for both pointer types (hover with a mouse, tap on touch). It replaces a bottom
// modal whose last row was covered by the fixed Dock. Round progress is read from the server,
// so cron-run rounds show up too. With an `action`, the status pill drops its refresh icon.

export interface SyncAction {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

function tone(attention: boolean) {
  return attention
    ? { dot: "bg-warn", badge: "bg-warn-bg text-warn" }
    : { dot: "bg-pos", badge: "bg-pos-bg text-pos" };
}

interface StatusSegmentProps extends React.ComponentPropsWithoutRef<"button"> {
  label: string;
  dotClass: string;
  busy: boolean;
  showRefresh: boolean;
}

// Always a full pill so its radius matches the popover goo; the opaque bg-card also masks the
// tucked-in part of the action segment.
const StatusSegment = forwardRef<HTMLButtonElement, StatusSegmentProps>(function StatusSegment(
  { label, dotClass, busy, showRefresh, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "flex h-9 items-center gap-2 rounded-full border border-border bg-card px-4 font-mono text-foreground text-xs transition-colors hover:bg-muted",
        className,
      )}
      {...rest}
    >
      <span className={cn("size-2 shrink-0 rounded-full", dotClass)} />
      <span className="text-muted-foreground">{label}</span>
      {showRefresh && (
        <RefreshCw className={cn(" text-muted-foreground", busy && "animate-spin")} />
      )}
    </button>
  );
});

// The pill stays in flow; the action button sits absolutely in the reserved pr-9 space.
// No overflow-hidden: it would clip the popover panel.
function ActionShell({ children, action }: { children: ReactNode; action: SyncAction }) {
  return (
    <div className="relative inline-flex pr-9">
      {children}
      <span className="absolute inset-y-2 right-9 z-10 w-px bg-border" />
      <button
        type="button"
        onClick={action.onClick}
        aria-label={action.label}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-full border border-l-0 border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4"
      >
        {action.icon}
      </button>
    </div>
  );
}

const SEGMENT_ACTION = "rounded-r-none border-r-0";

interface PanelProps {
  summary: SyncStatusSummary;
  round: SyncRoundView | null;
  startError: string | null;
  onSync: () => void;
  onPick: (accountId: string) => void;
  syncDisabled?: boolean;
}

function PanelRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-muted-foreground text-xs">
      <span className="shrink-0">{label}</span>
      <span className={cn("min-w-0 truncate text-foreground", mono && "font-mono")}>{value}</span>
    </div>
  );
}

// No hover state by design: it's a summary, and clicking is secondary. Keep the focus ring for
// keyboard users. The label is omitted when it equals the connector name.
function AttentionRow({
  source,
  connectorLabel,
  onPick,
}: {
  source: SyncAttentionSource;
  connectorLabel: string;
  onPick: (accountId: string) => void;
}) {
  const t = useTranslations("Sync");
  const syncedAt = useRelativeSyncedAt();
  const sameName = source.label.trim().toLowerCase() === connectorLabel.trim().toLowerCase();
  const status =
    source.kind === "missing-credentials"
      ? t("missingCredentials")
      : source.kind === "never-synced"
        ? t("neverSynced")
        : t("lastSyncedAt", { when: syncedAt(source.takenAt ?? 0) });
  return (
    <button
      type="button"
      onClick={() => onPick(source.id)}
      className="flex w-full items-baseline justify-between gap-3 rounded-md py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="min-w-0 truncate text-xs">
        <span className="font-medium">{connectorLabel}</span>
        {!sameName && <span className="text-muted-foreground"> @{source.label}</span>}
      </span>
      <span className="shrink-0 text-warn text-xs">{status}</span>
    </button>
  );
}

// The upstream error is shown verbatim: translating it would only distort it.
function FailureRow({
  failure,
  onPick,
}: {
  failure: SyncRoundFailure;
  onPick: (accountId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(failure.accountId)}
      className="flex w-full items-baseline justify-between gap-3 rounded-md py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="min-w-0 truncate font-medium text-xs">{failure.label}</span>
      <span className="min-w-0 truncate text-neg text-xs">{failure.error}</span>
    </button>
  );
}

// Exported for tests: rendering through <SyncStatus> needs router and portfolio context.
export function SyncPanel({
  summary,
  round,
  startError,
  onSync,
  onPick,
  syncDisabled,
}: PanelProps) {
  const t = useTranslations("Sync");
  const syncedAt = useRelativeSyncedAt();
  const busy = isRoundBusy(round);
  const needsAttention = hasAttention(summary, round, startError);
  const { badge } = tone(busy || needsAttention);
  const { data: catalog } = useQuery(connectorCatalogQuery());
  const nameOf = (id: ConnectorId) => catalog?.[id]?.label ?? connectorLabelFallback(id);
  // "Needs attention" rather than "partially synced": the list may be only stale-but-synced sources.
  const statusLabel = busy ? t("syncing") : needsAttention ? t("needsAttention") : t("allSynced");

  // One segment per outcome (synced / failed / needs keys / skipped), zero segments omitted.
  // Manual sources count as synced since they are valued on read. No round = never ran, so no
  // tally at all (a partial count would read as "only 2 of 10 synced").
  const notInRound = Math.max(0, summary.total - summary.accounts.length);
  // Clamp to the total: archiving a synced account mid-round shrinks the summary but not the round.
  const syncedCount = round ? Math.min(summary.total, round.synced + notInRound) : 0;
  const tally = round
    ? [
        syncedCount > 0 ? t("tallySynced", { count: syncedCount }) : null,
        round.failed.length > 0 ? t("tallyFailed", { count: round.failed.length }) : null,
        round.needsKeys > 0 ? t("tallyNeedsKeys", { count: round.needsKeys }) : null,
        round.skipped > 0 ? t("tallySkipped", { count: round.skipped }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  // Still the last successful sync while busy: how stale the numbers are matters most then.
  const lastUpdated = summary.lastSyncedAt ? syncedAt(summary.lastSyncedAt) : t("lastNever");

  // Running: progress + current account; finished: the tally; no round: source count only,
  // never an x/y fraction, since nothing has synced yet.
  const roundRows =
    round && busy ? (
      <>
        <PanelRow label={t("roundProgress")} value={`${round.settled} / ${round.total}`} mono />
        <PanelRow label={t("syncingNow")} value={round.current ?? "…"} />
      </>
    ) : tally ? (
      <PanelRow label={t("roundResult")} value={tally} />
    ) : (
      <PanelRow label={t("sources")} value={summary.total} mono />
    );

  // Interrupted = unfinished with a dead heartbeat. Not an account failure, but it must show,
  // or a broken round looks like success.
  const interrupted = round?.state === "interrupted";
  const fatal = startError ? `${t("startFailed")}: ${startError}` : (round?.error ?? null);
  const failures = round?.failed ?? [];
  const failureBlock =
    failures.length > 0 || fatal || interrupted ? (
      <>
        <div className="my-2 border-border border-t" />
        <div className="pb-1 font-medium text-muted-foreground text-xs">{t("roundFailed")}</div>
        <div className="flex flex-col">
          {failures.map((f) => (
            <FailureRow key={f.accountId} failure={f} onPick={onPick} />
          ))}
          {fatal ? <p className="py-1 text-neg text-xs">{fatal}</p> : null}
          {interrupted ? <p className="py-1 text-warn text-xs">{t("roundInterrupted")}</p> : null}
        </div>
      </>
    ) : null;

  const attentionBlock =
    summary.attention.length > 0 ? (
      <>
        <div className="my-2 border-border border-t" />
        <div className="flex flex-col">
          {summary.attention.map((a) => (
            <AttentionRow
              key={a.id}
              source={a}
              connectorLabel={nameOf(a.connectorId)}
              onPick={onPick}
            />
          ))}
        </div>
      </>
    ) : null;

  return (
    <div className="w-72 text-left">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-semibold text-sm">{t("status")}</span>
        <span className={cn("rounded-full px-2 py-1 font-semibold text-xs", badge)}>
          {statusLabel}
        </span>
      </div>

      {roundRows}
      <PanelRow label={t("lastUpdated")} value={lastUpdated} mono />

      {summary.dataStale ? <p className="py-1 text-warn text-xs">{t("staleWarning")}</p> : null}

      {/* Capped scroll area so a long list can't push the sync button off a phone screen. */}
      {failureBlock || attentionBlock ? (
        <div className="max-h-64 overflow-y-auto">
          {failureBlock}
          {attentionBlock}
        </div>
      ) : null}

      <div className="my-2 border-border border-t" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {busy ? t("hintSyncing") : t("hintResync")}
        </span>
        <IconButton
          size="sm"
          variant="outline"
          onClick={onSync}
          disabled={syncDisabled ?? (busy || summary.accounts.length === 0)}
          aria-label={t("status")}
          className="shrink-0 text-foreground [&_svg]:size-4"
        >
          <RefreshCw className={busy ? "animate-spin" : ""} />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * Failed accounts, a round that never started, and an interrupted round are invisible to the
 * summary (failed accounts still have snapshots and creds), so they're checked separately.
 * `dataStale` covers stale data before any per-account threshold trips.
 */
export function hasAttention(
  summary: SyncStatusSummary,
  round: SyncRoundView | null,
  startError: string | null = null,
): boolean {
  return (
    summary.attention.length > 0 ||
    summary.dataStale ||
    startError !== null ||
    (round != null &&
      (round.failed.length > 0 || round.error !== null || round.state === "interrupted"))
  );
}

export function SyncStatus({
  summary,
  action,
  autoSync,
}: {
  summary: SyncStatusSummary;
  action?: SyncAction;
  autoSync?: AutoSyncOption;
}) {
  const t = useTranslations("Sync");
  const { selectedId } = usePortfolio();
  const { round, busy, disabled, startError, sync } = useSyncRound(
    selectedId,
    summary.accounts.length,
    autoSync,
  );
  // By pointer capability, not viewport width: hover on touch screens sticks after a tap.
  const hoverCapable = useHoverCapable();
  // Controlled so picking a row can close it. Open: z-50 above the hero layer (beUI root is an
  // isolated stacking context). Closed: hide the goo backdrop so it doesn't show through.
  const [open, setOpen] = useState(false);

  const navigate = useNavigate();
  // The accounts page handles `focus` (scroll to row, or open its detail sheet if not in view).
  const pick = (accountId: string) => {
    setOpen(false);
    navigate({ to: "/{-$page}", params: { page: "accounts" }, search: { focus: accountId } });
  };

  const needsAttention = hasAttention(summary, round, startError);
  const { dot } = tone(busy || needsAttention);
  const triggerLabel = busy
    ? t("triggerSyncing")
    : needsAttention
      ? t("needsAttention")
      : t("triggerSynced");

  // Mouse: hover opens, click syncs. Touch: tap opens, syncing goes through the panel button.
  const popover = (
    <Popover
      trigger={hoverCapable ? "hover" : "click"}
      side="bottom"
      align="end"
      // Must be ≥ half the h-9 trigger height, or the goo shadow pill's corners poke out.
      panelRadius={18}
      open={open}
      onOpenChange={setOpen}
      className={cn(open ? "z-50" : "[&>[aria-hidden]]:hidden")}
    >
      <PopoverTrigger>
        <StatusSegment
          label={triggerLabel}
          dotClass={dot}
          busy={busy}
          showRefresh={!action}
          // Above the content layer (z-10): on the opening frame the content covers the pill and
          // already takes clicks, so mousedown/mouseup would split and drop the click.
          className={cn("z-20", action && SEGMENT_ACTION)}
          onClick={hoverCapable ? sync : undefined}
        />
      </PopoverTrigger>
      <PopoverContent>
        <SyncPanel
          summary={summary}
          round={round}
          startError={startError}
          onSync={sync}
          onPick={pick}
          syncDisabled={disabled}
        />
      </PopoverContent>
    </Popover>
  );

  return action ? <ActionShell action={action}>{popover}</ActionShell> : popover;
}
