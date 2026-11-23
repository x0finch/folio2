// Named defaults and fixed paths for perf:cpu; every CLI-overridable value has its default here.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** apps/web root (this file is in scripts/perf/). */
export const WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Dedicated local persist dir, never the dev DB `.wrangler/state`: Miniflare keys the SQLite by database_id under it, so a different persist dir is a different DB. */
export const PERF_STATE_DIR = join(WEB_ROOT, ".wrangler", "perf-state");

/** D1 migrations dir (same as `migrations_dir` in wrangler.jsonc). */
export const MIGRATIONS_DIR = join(WEB_ROOT, "..", "..", "packages", "db", "drizzle");

/** Build output: what `vite build` wrote and `wrangler deploy` ships as-is. */
export const DIST_SERVER_DIR = join(WEB_ROOT, "dist", "server");

// Ports avoid the dev server's 3000 and wrangler's default 8787 / 9229, so perf can run alongside `pnpm dev`.
export const DEFAULT_PORT = 3300;
export const DEFAULT_INSPECTOR_PORT = 9330;
export const HOST = "127.0.0.1";

/** Local fake-upstream port for perf:cpu:jobs (see fake-upstream.mjs). */
export const DEFAULT_FAKE_UPSTREAM_PORT = 3399;
/** Samples per job in perf:cpu:jobs (the first is reported separately as `:first`); the hourly sweep is heavy, so measure several. */
export const DEFAULT_SWEEP_REPS = 5;
export const DEFAULT_DAILY_REPS = 3;

/** Requests per endpoint, sequential. */
export const DEFAULT_REPS = 30;
/** Warm-up requests before sampling, so first-call compilation stays out of steady-state numbers (cold start has `--cold`). */
export const DEFAULT_WARMUP = 5;
/** V8 sampling interval (microseconds). */
export const DEFAULT_SAMPLING_US = 100;
/** Cloudflare Workers free plan: 10ms CPU per request. */
export const DEFAULT_BUDGET_MS = 10;

/** Cap and poll interval for wrangler dev to come up; it fetches `Request.cf` on start, so offline it waits for that to fail. */
export const READY_TIMEOUT_MS = 90_000;
export const READY_POLL_MS = 500;
/** Wait after SIGTERM before SIGKILL when stopping the worker. */
export const STOP_GRACE_MS = 5_000;

// Dataset defaults (see dataset.mjs); sizes can be overridden by arguments.
export const DEFAULT_ACCOUNTS = 8;
export const DEFAULT_TOKENS = 60;
export const DEFAULT_DAYS = 30;
/** Tokens with daily prices and how many days (for long-range curves). */
export const DAILY_PRICE_TOKENS = 20;
export const DAILY_PRICE_DAYS = 365;

/** Perf user. Exists only in the dedicated DB above; the password isn't a secret, it guards a local disposable DB. */
export const PERF_USER = {
  email: "perf@folio.test",
  password: "perf-password-1234",
  name: "Perf",
};

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
