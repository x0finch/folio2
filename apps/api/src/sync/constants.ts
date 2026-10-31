/**
 * Limits of one alarm invocation. The free plan allows 50 subrequests per invocation; D1 and
 * Durable Object calls may count too, so plugins get at most this many fetches per alarm.
 */
export const FETCH_BUDGET_PER_ALARM = 35
/** Stop starting new connections after this much wall time and continue in the next alarm. */
export const WALL_BUDGET_MS = 20_000
/** Transient failures (rate limits, upstream errors) are retried this many times. */
export const MAX_ATTEMPTS = 3
/** Backoff before retry n (1-based): 30 s, 2 min, 8 min. */
export const retryDelayMs = (attempt: number) => 30_000 * 4 ** (attempt - 1)
/** Users the scheduler enqueues per alarm. */
export const SCHEDULER_PAGE_SIZE = 20
