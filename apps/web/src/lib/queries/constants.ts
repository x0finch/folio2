import { isNotFound, isRedirect } from "@tanstack/react-router";

// Never a QueryClient-wide default: staleness is a property of each kind of data, and a global
// number silently applies to every future query. Targeted invalidation works regardless; staleTime
// only decides whether a remount refetches. Tiers follow how often the data changes, not the page.
export const STALE_TIME = {
  // Changes only on writes, which the data-version poll detects. The 15-minute cap is for prices:
  // enrichment prices refresh on a 30-minute TTL without bumping the data version.
  live: 15 * 60_000,
  // A new search term is a new key anyway.
  search: 60_000,
  // Only the rightmost point moves, on sync, which bumps the data version.
  history: 15 * 60_000,
  // Changed only explicitly by the user; this page invalidates and other devices see the version bump.
  settings: 60 * 60_000,
  // Follows deployments.
  catalogue: 60 * 60_000,
  // Just a dedupe window: the auth route may have fetched it right before the watcher mounts.
  // Polling ignores it.
  dataVersion: 5_000,
  // Static within a deployment.
  deployment: Number.POSITIVE_INFINITY,
} as const;

/**
 * Only while something is changing. syncRound: 1.5s suits a round of tens of seconds; faster only
 * loads the DB, slower feels stuck.
 */
export const POLL_INTERVAL = {
  syncRound: 1_500,
  /**
   * Only while the page is visible (react-query skips background intervals by default). The page's
   * only standing poll; everything else refetches on a version change.
   */
  dataVersion: 60_000,
  /** First sync in progress: exponential backoff from 1s, giving up after 8 attempts. */
  pending: 1_000,
} as const;

const PENDING_POLL_ATTEMPTS = 8;

/** Max backoff waits in `refetchUntil`. */
const REFETCH_WAITS = 4;

const backoffMs = (n: number) => Math.min(POLL_INTERVAL.pending * 2 ** n, 15_000);

function pendingPollDelay(pollCount: number): number | false {
  return pollCount >= PENDING_POLL_ATTEMPTS ? false : backoffMs(pollCount);
}

/**
 * Per-episode poll counts, keyed by query. `dataUpdateCount` alone is the query's lifetime success
 * count (refocus, invalidation and portfolio switches all bump it), so after nine successes polling
 * would stop for good and a finished sync would never show. Cleared when `pending` ends; the WeakMap
 * frees entries when queries leave the cache.
 */
const pollEpisodes = new WeakMap<object, number>();

export function pollWhilePending(
  query: { state: { dataUpdateCount: number } },
  pending: boolean,
): number | false {
  if (!pending) {
    pollEpisodes.delete(query);
    return false;
  }
  const startedAt = pollEpisodes.get(query);
  if (startedAt === undefined) {
    pollEpisodes.set(query, query.state.dataUpdateCount);
    return pendingPollDelay(0);
  }
  return pendingPollDelay(query.state.dataUpdateCount - startedAt);
}

/**
 * Writes only bump a watermark and recompute in `waitUntil`, so the immediate refetch often returns
 * pre-write data; without waiting, a freshly pinned tab can't be selected. Returns the last result
 * even if `ok` never holds.
 */
export const refetchUntil = async <A>(
  refetch: () => Promise<A>,
  ok: (a: A) => boolean,
): Promise<A> => {
  let out = await refetch();
  for (let n = 0; n < REFETCH_WAITS && !ok(out); n++) {
    await sleep(backoffMs(n));
    out = await refetch();
  }
  return out;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    // An abort during the previous request has already fired, so check before listening.
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Must be set explicitly: `fetchQuery` (used by ensureQueryData/prefetchQuery, i.e. every loader)
 * hard-codes `retry = false` when undefined, so one failure would be final. Backoff caps at 15s over
 * 5 attempts (~30s); after that QueryBoundary's self-heal timer takes over.
 */
export const RETRY = {
  attempts: 5,
  /** Shell-critical data has no degraded form; see `shouldRetry`. */
  forever: Number.POSITIVE_INFINITY,
  delay: (attempt: number) => Math.min(1_000 * 2 ** attempt, 15_000),
  /** Self-heal interval after a boundary falls; doubles on consecutive failures. */
  selfHeal: 15_000,
  selfHealMax: 60_000,
} as const;

/**
 * Never on the server: setting a function overrides query-core's server default of 0, and the
 * Worker has 10ms CPU per request. Never for redirects or 404s (control flow). Everything else
 * retries: server fn failures arrive as a generic Error, so 500 and 400 look alike.
 * `RETRY.forever` is for shell data and auth: without it there's no shell to draw.
 */
export function shouldRetry(
  failureCount: number,
  error: unknown,
  attempts: number = RETRY.attempts,
) {
  if (typeof window === "undefined") return false;
  if (isRedirect(error) || isNotFound(error)) return false;
  return failureCount < attempts;
}

/**
 * Same retry for calls outside react-query (the protected layout's `getSession()`). Redirects must
 * be rethrown. Auth passes `RETRY.forever`: an errored match never recovers on its own (`reset` only
 * clears boundary state and `Match` rethrows the same error), so only a reload would help.
 */
export async function withRetry<T>(
  call: () => Promise<T>,
  isControlFlow: (e: unknown) => boolean,
  attempts: number = RETRY.attempts,
  signal?: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    // The loop may be infinite, so it must honour cancellation (navigation aborts, discarded
    // hover prefetches); otherwise it keeps hitting the server until the tab closes.
    signal?.throwIfAborted();
    try {
      return await call();
    } catch (error) {
      if (isControlFlow(error) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY.delay(attempt)));
    }
  }
}
