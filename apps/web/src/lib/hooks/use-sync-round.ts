import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { isSyncDue } from "@/lib/core/sync-status";
import { syncKeys } from "@/lib/queries/keys";
import { invalidateFor } from "@/lib/queries/refresh";
import { syncRoundQuery } from "@/lib/queries/sync-round";
import type { SyncRoundView } from "@/lib/server/sync/status";

// Auto-sync cooldown per portfolio. Module-level on purpose: it must outlive remounts
// (switching portfolios, remount after a failed auto round) so each remount doesn't fire again.
const AUTO_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const lastAutoSyncAt = new Map<string, number>();

// Progress lives on the server; the client only starts a round and polls it.
export const isRoundBusy = (round: SyncRoundView | null | undefined): boolean =>
  round?.state === "running";

export interface SyncRoundHandle {
  round: SyncRoundView | null;
  busy: boolean;
  disabled: boolean;
  /** Starting the round failed, as opposed to an account failing within the round. */
  startError: string | null;
  sync: () => void;
}

/** Only the home page passes this. */
export interface AutoSyncOption {
  /** Latest snapshot; older than an hour (or never synced) triggers an auto round. */
  lastSyncedAt: number | null;
}

export function useSyncRound(
  portfolioId: string,
  syncableCount: number,
  autoSync?: AutoSyncOption,
): SyncRoundHandle {
  const queryClient = useQueryClient();
  const { data, isPending: roundPending } = useQuery(syncRoundQuery(portfolioId));
  const round = data ?? null;
  const busy = isRoundBusy(round);

  const mutation = useMutation({
    // `auto` lets the server skip fresh accounts; a manual sync forces all of them.
    mutationFn: async (vars: { auto: boolean } = { auto: false }): Promise<SyncRoundView> => {
      // The server decides which accounts to run; the client only names the portfolio.
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portfolioId, auto: vars.auto }),
      });
      if (!response.ok) throw new Error(`sync failed: ${response.status}`);
      return (await response.json()) as SyncRoundView;
    },
    // Seed the cache with the response. Cancel the in-flight GET first: it may have left before
    // the round started and would overwrite the new round with the old one.
    onSuccess: async (view) => {
      await queryClient.cancelQueries({ queryKey: syncKeys.round(portfolioId) });
      queryClient.setQueryData(syncKeys.round(portfolioId), view);
    },
    // A lost response doesn't mean no round started; polling only self-starts on `running`,
    // so refetch once to pick it up.
    onError: () => queryClient.invalidateQueries({ queryKey: syncKeys.round(portfolioId) }),
  });

  // The mark is stored with its portfolio so a round from portfolio B isn't read as progress
  // on A, and A's start error isn't shown on B.
  const seen = useRef<{ portfolioId: string; mark: string | null }>({ portfolioId, mark: null });
  const reset = mutation.reset;
  useEffect(() => {
    if (seen.current.portfolioId !== portfolioId) {
      seen.current = { portfolioId, mark: null };
      reset();
    }
    if (!round) return;
    // Compare by value, not reference (structural sharing is an implementation detail).
    // The first sighting is an old round from page load, so it doesn't invalidate.
    const mark = `${round.roundId}:${round.settled}:${round.state}`;
    if (seen.current.mark === mark) return;
    const first = seen.current.mark === null;
    seen.current = { portfolioId, mark };
    if (first) return;
    void invalidateFor(queryClient, "sync.round");
  }, [round, queryClient, portfolioId, reset]);

  // Silent auto-sync on the home page when data is stale. Guards: once per portfolio per mount,
  // a module-level cooldown across remounts, and never while a round is running.
  const mutate = mutation.mutate;
  const pending = mutation.isPending;
  const autoFired = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSync) return;
    // Until the round is loaded `busy` reads false and would race a round already running.
    if (roundPending) return;
    if (busy || pending) return;
    if (syncableCount === 0) return;
    if (autoFired.current === portfolioId) return;
    if (!isSyncDue(autoSync.lastSyncedAt, Date.now())) return;
    const now = Date.now();
    if (now - (lastAutoSyncAt.get(portfolioId) ?? 0) < AUTO_SYNC_COOLDOWN_MS) return;
    autoFired.current = portfolioId;
    lastAutoSyncAt.set(portfolioId, now);
    mutate({ auto: true });
  }, [autoSync, busy, pending, roundPending, syncableCount, portfolioId, mutate]);

  const disabled = busy || mutation.isPending || syncableCount === 0;

  return {
    round,
    busy,
    disabled,
    startError: mutation.error ? mutation.error.message : null,
    sync: () => {
      if (disabled) return;
      mutation.mutate({ auto: false });
    },
  };
}
