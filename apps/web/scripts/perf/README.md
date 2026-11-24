# Perf scripts — server CPU per endpoint and per job

Cloudflare Workers' free plan gives each request **10 ms of CPU**. For performance work, run the relevant script before and after the change and paste both tables into the PR.

Don't trust the `durationMs` server-fn log: workerd's `performance.now()` stops during synchronous compute, so it only sees I/O waits and reads 2–10× low. These scripts measure from outside with the V8 sampling profiler.

## `perf:cpu` — read endpoints

```sh
pnpm --filter @folio/web perf:cpu                     # build → seed → 30 requests per endpoint
pnpm --filter @folio/web perf:cpu --no-build --only fn-getSnapshots-now,doc-root-authed
pnpm --filter @folio/web perf:cpu --cold --only fn-getValuationSettings   # first request on a cold isolate
pnpm --filter @folio/web perf:cpu --list              # endpoints
pnpm --filter @folio/web perf:cpu --help              # all flags
```

Needs `apps/web/.dev.vars` with at least `BETTER_AUTH_SECRET` and `SECRETS_KEY`. The script builds (`--no-build` skips), migrates and seeds a dedicated local database in `apps/web/.wrangler/perf-state/` (your dev database is untouched; size via `--accounts` / `--tokens` / `--days`, `--no-seed` reuses the last data), runs `wrangler dev` on the build output on port 3300 (inspector 9330, so it can run alongside `pnpm dev`), warms each endpoint with 5 requests and profiles 30. It overrides `BETTER_AUTH_URL` to its own origin and drops `LOG_LEVEL` / `LOG_PRETTY` so production log settings apply. No secret values are printed.

Add an endpoint in `endpoints.mjs` → `ENDPOINTS`: `fn: "<handler name>"` (GET only) with optional `data: (ctx) => ({ … })`, or `path` for documents and routes; `expect` for a non-200 status.

### Reading the output

```
   endpoint                  status  mean   p50   max  proc  wall p50  owners (mean ms/req)
!  fn-getValuationSettings*  200     22.0  21.2  44.9  20.6      24.4  Effect 10.2 · TanStack Start 2.8 · V8 native 2.3 · GC 2.0
   static-favicon            200      0.0   0.0   0.0   4.0       5.0
```

- **mean / p50 / max** — sampled CPU ms per request (JS self time + GC). **mean is the headline number.** `!` = mean over `--budget-ms` (default 10).
- **proc** — cross-check from the kernel's CPU time for workerd, without sampling. It also counts local-only work (local D1, HTTP parsing; the `static-favicon` row shows that floor). mean ≈ proc → the sample is trustworthy; mean ≫ proc → the machine was busy, discard the run.
- **`*`** after a name — over a quarter of the CPU came from sparse samples (the first sample after an idle gap carries the gap). mean is still usable; p50 / max are rough.
- **wall p50** — round trip seen from Node. wall ≫ CPU means the endpoint is waiting on I/O.
- **status** — `401≠200` means it measured an error path; ignore the numbers.
- **owners** — where the ms go, mapped back to packages from the build's `//#region` comments (`Effect`, `TanStack Start`, `better-auth`, `D1 driver`, `React SSR`, `GC`, `V8 native`, `app code (@folio/*)`, …).
- **`static-favicon`** is the control: static assets don't reach the Worker, so it must be 0.

Output goes to `.wrangler/perf-state/runs/<timestamp>/` (`--out` to change): one `.cpuprofile` per endpoint (load in Chrome DevTools › Performance), `summary.json` (per-request CPU, owners, top 25 modules, GC, dataset size, machine load) and `wrangler.log`. `--fail-over-budget` exits 1 if any mean is over budget.

### Caveats

- These are local CPU ms, not edge ms; there is no conversion factor. Compare **shapes** (who dominates, ratios, before/after). The real numbers are `cpuTime` in Workers Logs (`perf:cpu:online`).
- A busy machine inflates everything; the script warns when load exceeds ¾ of the cores. Run before/after on a quiet machine.
- One request at a time, read paths only, and no manual accounts in the dataset (they would hit CoinGecko on every request).
- `--cold` includes module evaluation and first-call initialization; Cloudflare bills Worker startup separately.

## `perf:cpu:jobs` — cron and background job CPU

```sh
pnpm --filter @folio/web perf:cpu:jobs                     # build → seed → measure both crons
pnpm --filter @folio/web perf:cpu:jobs --no-build --only cron-sweep --reps 3
pnpm --filter @folio/web perf:cpu:jobs --list              # cron-daily / cron-sweep
```

Measures the write path: the hourly sweep (`30 * * * *`) and the daily cron (`0 23 * * *`), plus every `JobRunner` Durable Object alarm they cause. A fake upstream (`fake-upstream.mjs`, `127.0.0.1:3399`) stands in for every provider and CoinGecko with production-sized, deterministic responses; the Worker is pointed at it through `*_API_BASE` overrides and fake keys. Seeded accounts have real encrypted credentials so sync actually runs. The Worker restarts for every invocation (production crons usually land on a cold isolate) and prices are marked stale first. Each task gets one `:first` run, then `--reps` steady-state runs. A sweep takes over two minutes locally because delayed jobs fire 120 s later.

Diagnostics: `--warm` keeps one Worker per scenario (cold vs warm cost); `--cron-only` binds `JOB_RUNNER` to a stub so only `scheduled()` is measured.

### Reading the output

```
   invocation                     n  status   mean … fetches  result                  owners
!  cron-sweep:first*              1  200      70.0 …     0  synced 8/8, jobs 13/13  …
!  cron-sweep:window              1  200     645.5 …     0  synced 8/8, jobs 13/13  …
!  cron-sweep:alarm:sync-account  8  done     59.0 …     3  8.0 per trigger
```

- Rows: `<task>` is the cron invocation itself; `<task>:window` is the cron plus every alarm it caused (total is exact); `<task>:alarm:<kind>` is one sample per alarm of that job kind (the budget applies per invocation). Per-kind splits are approximate: alarms are cut at each job's completion log line.
- **mean** is an upper bound: samples after idle gaps are capped at 10 × the sampling interval (the excess goes to `gapMs` in the summary). `*` means capped samples are over a quarter of the total — run more reps and watch p50.
- **proc** includes local D1, HTTP parsing and the profiler itself, so it runs well above mean; use it only to see whether the total moved.
- **wall p50** is mostly rate-limit queuing, not CPU.
- **fetches** — requests the fake upstream received (per route in `summary.json` → `fetchesByRoute`).
- **result** — `synced ok/total` and `jobs done/enqueued`, read from the run's own logs. A `✗` means something failed or timed out; ignore that row. Alarm rows show `done` / `retried` / `buried`.

Output: `.wrangler/perf-state/runs/jobs-<timestamp>/` with a `.cpuprofile` and `.slots.json` per invocation, `summary.json` and `wrangler.log`.

Limits: the fake upstream never fails or throttles (retry paths aren't measured); Bitcoin uses a single address; EVM uses Rabby only; one user.

## `perf:cpu:analyze` — function-level breakdown

```sh
pnpm --filter @folio/web perf:cpu:analyze <run-dir>                    # self / inclusive top 25 per kind
pnpm --filter @folio/web perf:cpu:analyze <run-dir> --kind sync-account --top 40
pnpm --filter @folio/web perf:cpu:analyze <run-dir> --tree --kind cron  # top-down tree
```

Numbers are per-invocation averages with the same windowing and capping as the tables. `--tree` collapses Effect runtime frames (`runLoop`, `evaluateEffect`) by default (`--collapse` to change). Each run dir stores its own `regions.json`, so it still works after `dist/` is rebuilt.

## `perf:cpu:online` — production numbers

```sh
CLOUDFLARE_OBSERVABILITY_TOKEN=… pnpm --filter @folio/web perf:cpu:online            # current version, last 7 days
pnpm --filter @folio/web perf:cpu:online --version all --days 1 --token-env MY_VAR
```

Reads Cloudflare's `cpuTimeMs` from Workers Logs. Needs an **account-level** API token (Account API Tokens, Worker `folio`, Metadata Read-Only); a personal token can't read the logs endpoint.

- The per-invocation-type and per-cron tables are complete counts — `exceededCpu` counts can be quoted.
- The per-server-fn and per-job-kind tables are sampled (`n` = samples); don't derive totals from them, and prefer p90 over P99 when `n` is small. Alarms killed for exceeding CPU never log their job, so they show up as unmatched; use `alarm · exceededCpu` from the complete table.
- By default only the current production version is shown; a fresh deploy with no traffic gives empty tables.

## `perf:requests` — requests per page load

```sh
PLAYWRIGHT_BROWSERS_PATH=… pnpm --filter @folio/web perf:requests --no-build
```

Logs in with Playwright on the perf build, cold-opens `/`, waits for the network to settle, then reloads. Counts `/_serverFn/*`, `/api/*` and `/api/logo/*`; the `server` column comes from requests that actually reached the Worker. Details in `.wrangler/perf-state/runs/requests-<timestamp>/summary.json`. The cold open includes a second document load after the service worker installs — see `navigations`.
