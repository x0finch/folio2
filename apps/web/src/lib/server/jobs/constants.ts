import { DEFAULT_TOP_N } from "@folio/oracle-basic";

/** Retries after the first run. Once exhausted the runner buries the job (kept in DO storage). */
export const JOB_MAX_RETRIES = 3;

export const isFinalAttempt = (attempts: number): boolean => attempts > JOB_MAX_RETRIES;

/** Exponential backoff base; doubles each retry. */
const JOB_RETRY_BASE_DELAY_MS = 30_000;

/**
 * Delay after failed `attempt` (30s → 60s → 120s). Retries are ours, not the platform's: alarm
 * retries are capped at 6 with no control over spacing, so the alarm always returns normally.
 */
export const jobRetryDelayMs = (attempt: number): number =>
  JOB_RETRY_BASE_DELAY_MS * 2 ** (Math.max(attempt, 1) - 1);

export const JOB_RETRY_MAX_DELAY_MS = jobRetryDelayMs(JOB_MAX_RETRIES);

/** One `sync-account` delivery: 3 upstream tries × 20s timeout + backoff ≈ 70s, plus 10s for D1. */
export const SYNC_ATTEMPT_BUDGET_MS = 80_000;

/** Delay between due time and actual start, excluding backlog (one DO runs one job per alarm). */
export const SCHEDULING_SLACK_MS = 10_000;

/**
 * Lease after claiming a job. The attempt is counted at claim time, so a DO evicted mid-run
 * re-claims after the lease, and an unfinished final attempt is buried instead of rerun.
 */
export const JOB_LEASE_MS = SYNC_ATTEMPT_BUDGET_MS + SCHEDULING_SLACK_MS;

/** Worst case from first run to final give-up: 4 × 80 + (30 + 60 + 120) + 3 × 10 = 560s. */
export const SYNC_RETRY_CHAIN_MS =
  (JOB_MAX_RETRIES + 1) * SYNC_ATTEMPT_BUDGET_MS +
  // Geometric sum of backoffs 1..n = base × (2^n − 1).
  JOB_RETRY_BASE_DELAY_MS * (2 ** JOB_MAX_RETRIES - 1) +
  JOB_MAX_RETRIES * SCHEDULING_SLACK_MS;

export const DEAD_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Overdue alarm age at which a cron poke warns and force re-arms; the runner may be stuck. */
export const RUNNER_STALL_MS = 15 * 60 * 1000;

/** Single runner instance; all users' jobs share one line. */
export const JOB_RUNNER_NAME = "jobs";

/**
 * Delay for jobs that read the latest snapshot (`platforms` / `defi-logos`) so they run after the
 * same user's `sync-account` lands. Best-effort cache warming, so lateness costs nothing.
 */
export const AFTER_SYNC_DELAY_SECONDS = 120;

// Copied from the CoinGecko adapter (RETRY_ATTEMPTS, MARKETS_PER_PAGE); the app doesn't know it.
// Recompute the budgets below if they change.
const UPSTREAM_ATTEMPTS = 2;
const CATALOGUE_ROWS_PER_PAGE = 250;

/**
 * Worst-case upstream calls per reference job, all well under the free plan's 50 subrequests:
 * fx and platforms are one call each, catalogue is ⌈1000 / 250⌉ pages; defi-logos and
 * prune-notes make none. Each is × 2 attempts.
 */
export const REFERENCE_JOB_UPSTREAM_CALLS = {
  fx: 1 * UPSTREAM_ATTEMPTS,
  platforms: 1 * UPSTREAM_ATTEMPTS,
  catalogue: Math.ceil(DEFAULT_TOP_N / CATALOGUE_ROWS_PER_PAGE) * UPSTREAM_ATTEMPTS,
  "defi-logos": 0,
  "prune-notes": 0,
} as const;

/**
 * Derived from the 50-subrequest budget: two endpoints, 100 ids per request, 2 attempts each →
 * 1000 ids cost at most (10 + 10) × 2 = 40 calls.
 */
export const PRICES_IDS_PER_MESSAGE = 1000;

/**
 * Range requests per `daily-prices` message (each ≤ 365 days, × 2 attempts = 16 calls). The 10ms
 * CPU limit binds before the subrequest budget: parsing and writing ~3k daily rows. Untested
 * conservative guess; leftovers go to a follow-up message. Fiat windows count as 2 calls.
 */
export const DAILY_PRICES_CALLS_PER_MESSAGE = 8;

/** Message-body cap only; the upstream budget is set above. */
export const DAILY_PRICES_IDS_PER_MESSAGE = 1000;

export const DAILY_PRICES_UPSTREAM_CALLS = DAILY_PRICES_CALLS_PER_MESSAGE * UPSTREAM_ATTEMPTS;
