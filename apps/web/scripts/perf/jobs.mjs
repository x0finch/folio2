#!/usr/bin/env node
// CPU of the background write path: how much server CPU one `scheduled()` (and the jobs it posts to the runner, if any) costs.
//
//   pnpm --filter @folio/web perf:cpu:jobs                         # build, seed, one round per cron
//   pnpm --filter @folio/web perf:cpu:jobs --no-build --only cron-sweep --reps 3
//   pnpm --filter @folio/web perf:cpu:jobs --list
//
// Same method as perf:cpu (build output + wrangler dev + V8 sampling + /proc cross-check) applied to cron jobs: wrangler dev's `/cdn-cgi/handler/scheduled?cron=...` enters `scheduled()` and answers only after waitUntil finishes, so one trigger is one full cron invocation. Upstreams are all replaced by the local fake (fake-upstream.mjs) since egress is blocked and every step needs it.
//
// The worker restarts every time (fresh isolate, modules already evaluated by the readiness probe): production's hourly cron mostly lands on an isolate that hasn't warmed this path, whereas repeated triggers in one isolate have hot JIT and module caches and understate. Token prices are also marked expired between restarts (see expirePrices).
//
// Runner: both crons only post jobs and the real work runs in the `JobRunner` DO's alarm, one job per alarm. After a trigger we wait for every posted job to finish (the cron's log line reports how many were posted and the consumer logs one line with `kind` per job), then a quiet period (relay-posted follow-ups). Local alarms leave no per-invocation log line (workerd schedules them and wrangler dev prints nothing), so slots are cut by the app's own end lines: a job's slot runs from the previous end (the first from the cron's post line) to its own end (see alarmSlots). The DO shares the worker's isolate, so the sampler sees it; with no JOB_RUNNER binding in the build, that part is skipped.
//
// Why it exists and how to read the output: see scripts/perf/README.md.
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_BUDGET_MS,
  DEFAULT_DAILY_REPS,
  DEFAULT_DAYS,
  DEFAULT_FAKE_UPSTREAM_PORT,
  DEFAULT_INSPECTOR_PORT,
  DEFAULT_PORT,
  DEFAULT_SAMPLING_US,
  DEFAULT_SWEEP_REPS,
  DEFAULT_TOKENS,
  PERF_STATE_DIR,
  WEB_ROOT,
} from "./constants.mjs";
import { clearSyncRounds, expirePrices, refIndexRowCount } from "./dataset.mjs";
import { startFakeUpstream } from "./fake-upstream.mjs";
import { snapshotRegions } from "./owners.mjs";
import { attribute, COARSE_SAMPLE_FACTOR, hostLoad, profileWindow, withCdp } from "./profiler.mjs";
import { formatJobsTable, quantile } from "./report.mjs";
import { prepareData } from "./session.mjs";
import {
  build,
  builtConfig,
  checkDevVars,
  clearDurableObjectState,
  migrate,
  originOf,
  startWorker,
  stopAll,
} from "./worker.mjs";

/** The cron jobs under test. Expressions match `triggers.crons` in wrangler.jsonc (server.ts branches on them). `beforeEach`: what to do to the DB before each trigger (worker stopped) so the state matches production's. `resultOf`: reads "what it accomplished" from the invocation's logs; a measurement of the error path is void. */
const SCENARIOS = [
  // Both only post jobs: `enqueued` is the message of the cron's post-complete log line, whose `jobs` field is how many were posted; when waiting for the runner to drain we wait for that many to finish (`settleRunner`).
  //
  // The daily one only posts jobs (prune-notes / catalogue). The global ref map is no longer refreshed here: it moved to a Node script in GitHub Actions and doesn't use the Worker's budget (its timing is in `refreshRefIndex` below; the sweep needs a non-empty table, so it runs once after seeding).
  {
    key: "cron-daily",
    cron: "0 23 * * *",
    label: "daily: enqueue prune-notes + catalogue",
    reps: DEFAULT_DAILY_REPS,
    enqueued: "daily jobs enqueued",
    beforeEach: () => {},
    resultOf: (logs, settled) => {
      const done = logEvent(logs, "daily jobs enqueued");
      if (!done) return legacyDailyResult(logs);
      const drained = drainedResult(settled);
      return {
        ok: drained.ok,
        text: `users ${done.users}, ${drained.text}`,
        detail: { ...done, runner: settled?.summary },
      };
    },
  },
  // Hourly sweep: the cron only opens the round and posts messages; one `sync-account` per account, plus `hourlyUserJobs` per user (prices / daily-prices / fx immediately, platforms / defi-logos delayed 120s), so draining can't rely on "quiet for a few seconds" and must wait until all posted jobs finish. Success is judged in two places: each round's end log (`queued round done`, printed by the last sync-account) has synced == total, and every job is done.
  {
    key: "cron-sweep",
    cron: "30 * * * *",
    label: "hourly: open rounds + enqueue (sync-account per account, reference jobs per user)",
    reps: DEFAULT_SWEEP_REPS,
    enqueued: "cron sweep enqueued",
    beforeEach: ({ userId }) => expirePrices(userId),
    resultOf: (logs, settled) => {
      const done = logEvent(logs, "cron sweep enqueued");
      if (!done) return legacySweepResult(logs);
      const rounds = logEvents(logs, "queued round done");
      const total = rounds.reduce((n, r) => n + r.total, 0);
      const synced = rounds.reduce((n, r) => n + r.synced, 0);
      const drained = drainedResult(settled);
      return {
        // `--cron-only`: the runner isn't awaited (`settled.summary` is empty); only check that the cron itself posted successfully.
        ok:
          done.failed === 0 &&
          (!settled?.summary || (rounds.length > 0 && synced === total && drained.ok)),
        text: `synced ${synced}/${total}, ${drained.text}`,
        detail: { ...done, rounds, runner: settled?.summary },
      };
    },
  },
];

/** Code from before the fan-out has no "enqueued" line: the cron did the work itself and each logged an end line. Kept so the same harness can measure the pre-change code for before/after (when the daily cron still refreshed the map in the Worker). */
function legacyDailyResult(logs) {
  const done = logEvent(logs, "global ref index refresh done");
  if (!done) return { ok: false, text: "no enqueued log" };
  return {
    ok: true,
    text: `legacy: ref index rows ${done.rows} +${done.inserted}/~${done.updated}/-${done.deleted}`,
    detail: done,
  };
}

function legacySweepResult(logs) {
  const done = logEvent(logs, "cron sweep done");
  if (!done) return { ok: false, text: "no enqueued log" };
  const total = done.ok + done.failed + done.skipped;
  return {
    ok: done.failed === 0 && done.skipped === 0,
    text: `legacy: synced ${done.ok}/${total}`,
    detail: done,
  };
}

/** Whether the runner half succeeded: every posted job finished and none was buried / undecodable. No runner means no judgement. */
function drainedResult(settled) {
  if (!settled?.summary) return { ok: true, text: "no runner" };
  const { expected, done, buried, retried, invalid, timedOut } = settled.summary;
  const ok = !timedOut && expected !== null && done >= expected && buried === 0 && invalid === 0;
  const extra = [
    retried && `${retried} retried`,
    buried && `${buried} buried`,
    timedOut && "timeout",
  ]
    .filter(Boolean)
    .join(", ");
  return { ok, text: `jobs ${done}/${expected ?? "?"}${extra ? ` (${extra})` : ""}` };
}
const SCENARIO_KEYS = SCENARIOS.map((s) => s.key);

/** Max wait for one trigger (the cron queues behind its own gate, and the first round walks the catalogue and writes tens of thousands of rows). */
const INVOCATION_TIMEOUT_MS = 10 * 60_000;
/** Drain criterion for the runner: after all posted jobs have ended, this long with no new end log (relay-posted follow-ups such as a `prices` budget split or a `daily-prices` remainder carry no delay and land in this quiet). */
const RUNNER_QUIET_MS = 2_000;
/** The runner's DO binding name (wrangler.jsonc `durable_objects`, looked up by `jobs/queue.ts`). */
const RUNNER_BINDING = "JOB_RUNNER";
/** The consumer's end log per job (`jobs/consume.ts`, all with `kind`). `terminal`: the job won't run again. The runner logs a separate line (`job give-up could not run`) only when the end step itself failed; it isn't listed since a buried record always precedes it. Each line is also the end of one alarm (one job per alarm, `jobs/runner.ts`), which is how slots are cut (see alarmSlots). */
const JOB_LOGS = {
  "job done": { terminal: true, outcome: "done" },
  "job failed, will retry": { terminal: false, outcome: "retried" },
  "job failed on final attempt, burying it": { terminal: true, outcome: "buried" },
  "job never finished its final attempt, burying it": { terminal: true, outcome: "buried" },
  "invalid job dropped": { terminal: true, outcome: "invalid" },
};
/** Poll interval for draining. */
const SETTLE_POLL_MS = 50;
/** Log timestamp (LogTape JSON `@timestamp`, wall-clock ms) to the local monotonic clock (microseconds, as the profile uses): same machine, so a constant offset, measured once at start. Millisecond precision, and workerd's `Date.now()` advances only at I/O boundaries; the end line prints right after a job's last I/O, so the recorded time is about when it really ended (the trailing sync CPU falls in the next slot). */
const EPOCH_OFFSET_US = Date.now() * 1000 - Number(process.hrtime.bigint() / 1000n);
const monoUsOf = (epochMs) => epochMs * 1000 - EPOCH_OFFSET_US;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const USAGE = `usage: perf:cpu:jobs [options]
  --no-build             reuse the existing dist/ (default: vite build first)
  --no-seed              keep the perf DB as is (default: wipe + reseed)
  --only a,b             scenarios to run (see --list)
  --list                 print scenario keys and exit
  --reps N               invocations per scenario after the first
                         (default: cron-sweep ${DEFAULT_SWEEP_REPS}, cron-daily ${DEFAULT_DAILY_REPS})
  --sampling-us N        V8 sampling interval in µs (default ${DEFAULT_SAMPLING_US})
  --budget-ms N          per-invocation CPU budget (default ${DEFAULT_BUDGET_MS})
  --accounts N           seeded accounts (default ${DEFAULT_ACCOUNTS})
  --tokens N             seeded tokens (default ${DEFAULT_TOKENS})
  --days N               days of hourly snapshots (default ${DEFAULT_DAYS})
  --port N               worker port (default ${DEFAULT_PORT})
  --inspector-port N     inspector port (default ${DEFAULT_INSPECTOR_PORT})
  --upstream-port N      fake upstream port (default ${DEFAULT_FAKE_UPSTREAM_PORT})
  --cron-only            measure the scheduled() invocation only: JOB_RUNNER is bound to a no-op
                         stub DO in a second worker, so no alarm runs inside the sampled window
  --warm                 keep one worker per scenario (default: restart before every invocation);
                         shows how much of an invocation is cold-isolate cost
  --out DIR              output dir (default ${join(PERF_STATE_DIR, "runs", "jobs-<timestamp>")})`;

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "no-build": { type: "boolean", default: false },
      "no-seed": { type: "boolean", default: false },
      only: { type: "string" },
      list: { type: "boolean", default: false },
      reps: { type: "string" },
      "sampling-us": { type: "string", default: String(DEFAULT_SAMPLING_US) },
      "budget-ms": { type: "string", default: String(DEFAULT_BUDGET_MS) },
      accounts: { type: "string", default: String(DEFAULT_ACCOUNTS) },
      tokens: { type: "string", default: String(DEFAULT_TOKENS) },
      days: { type: "string", default: String(DEFAULT_DAYS) },
      port: { type: "string", default: String(DEFAULT_PORT) },
      "inspector-port": { type: "string", default: String(DEFAULT_INSPECTOR_PORT) },
      "upstream-port": { type: "string", default: String(DEFAULT_FAKE_UPSTREAM_PORT) },
      out: { type: "string" },
      warm: { type: "boolean", default: false },
      "cron-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const num = (name) => {
    const n = Number(values[name]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
    return n;
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    help: values.help,
    list: values.list,
    build: !values["no-build"],
    seed: !values["no-seed"],
    only: values.only
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    reps: values.reps === undefined ? undefined : num("reps"),
    samplingUs: num("sampling-us"),
    budgetMs: num("budget-ms"),
    dataset: { accounts: num("accounts"), tokens: Math.max(1, num("tokens")), days: num("days") },
    port: num("port"),
    inspectorPort: num("inspector-port"),
    upstreamPort: num("upstream-port"),
    warm: values.warm,
    cronOnly: values["cron-only"],
    out: values.out ?? join(PERF_STATE_DIR, "runs", `jobs-${stamp}`),
  };
}

const log = (msg) => process.stderr.write(`[perf:jobs] ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowUs = () => Number(process.hrtime.bigint() / 1000n);

/** Reads the log file from an offset to the end. wrangler appends; we only read. */
function readFileFrom(file, from) {
  const size = statSync(file).size;
  const buf = Buffer.alloc(Math.max(0, size - from));
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, from);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

/** Incremental log reader: each call returns what was written since the last (used to spot end lines while draining). */
function logCursor(file) {
  let offset = statSync(file).size;
  return () => {
    const text = readFileFrom(file, offset);
    offset += Buffer.byteLength(text);
    return text;
  };
}

/** A log line that is a LogTape JSON line (production format, JSON Lines) becomes `{ message, properties, atMs }`, else undefined. `atMs` is the `@timestamp` wall-clock ms (null if missing or unparseable). */
function logRecord(line) {
  const at = line.indexOf("{");
  if (at < 0 || !line.includes('"message"')) return undefined;
  try {
    const rec = JSON.parse(line.slice(at));
    if (typeof rec.message !== "string") return undefined;
    const atMs = Date.parse(rec["@timestamp"]);
    return {
      message: rec.message,
      properties: rec.properties ?? {},
      atMs: Number.isFinite(atMs) ? atMs : null,
    };
  } catch {
    return undefined; // half a line / not JSON: skip
  }
}

/** Properties of all records of a log message, in order of appearance. */
function logEvents(text, message) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.includes(`"${message}"`)) continue;
    const rec = logRecord(line);
    if (rec?.message === message) out.push(rec.properties);
  }
  return out;
}

/** Properties of the last record of a log message; undefined if none. */
function logEvent(text, message) {
  return logEvents(text, message).at(-1);
}

/** The runner in the build (the class bound as JOB_RUNNER in `durable_objects`). null if absent, which skips all runner logic. */
function runnerConfig() {
  const binding = builtConfig().durable_objects?.bindings?.find((b) => b.name === RUNNER_BINDING);
  return binding ? { binding: binding.name, className: binding.class_name } : null;
}

/** Cuts the end lines into per-alarm slots. Locally there are no alarm start/end markers (wrangler dev prints nothing when workerd schedules one), so only the app's own end lines are usable; one alarm runs one job (`jobs/runner.ts`), so an end line is the end of one alarm: slot k = [end of job k-1, end of job k), the first from the cron's post line (`enqueuedUs`). A slot therefore also holds the tail after the previous alarm's end (ack row delete, re-arming the alarm) and this alarm's entry cost, both belonging to "one alarm" but charged to the wrong slot, at sub-millisecond scale. Idle waits in between (120s delayed jobs, retry backoff) aren't CPU: the sampler stops while the isolate idles and the first sample after resuming is capped by maxSampleUs, the same convention as a cron slot. The cron itself has a small tail after posting (`pokeRunner`) that lands in the first slot; with several users in a sweep, earlier users' jobs interleave with later users' posting, so per-kind numbers are approximate while the whole-window total is accurate. */
function alarmSlots(completions, enqueuedUs, fallbackUs) {
  let prev = enqueuedUs ?? fallbackUs;
  return completions
    .toSorted((a, b) => a.atUs - b.atUs)
    .map((c) => {
      const startUs = Math.min(prev, c.atUs);
      prev = Math.max(prev, c.atUs);
      return {
        startUs,
        kind: c.kind,
        outcome: c.outcome,
        attempts: c.attempts,
        // The wall clock between two end lines isn't this alarm's wall clock (may include a 120s delay): not reported.
        wallMs: null,
        alarm: true,
      };
    });
}

/** After a trigger, waits for the runner to finish the jobs it posted. With no runner (or `--cron-only`) returns immediately (the scheduled request answering means it finished). With a runner it reads logs and records, in order of appearance: the `jobs` of the cron's post line (`scenario.enqueued`), the count to wait for, with its timestamp (the first slot's start); and each consumer end line (`JOB_LOGS`): kind, outcome, timestamp (that slot's end). It stops when ended count >= posted count and no new end line arrives within RUNNER_QUIET_MS. "Quiet for a few seconds" alone isn't enough: `platforms` / `defi-logos` are delayed 120s and the gap is quiet. workerd CPU isn't used to judge quiet: an idle workerd with the sampler on burns 5-10ms CPU every 50ms and jitters. */
async function settleRunner(runner, readLog, scenario) {
  if (!runner) return { invocations: [], summary: null };
  const settleFromUs = nowUs();
  const completions = [];
  let enqueuedUs = null;
  const tally = { expected: null, done: 0, retried: 0, buried: 0, invalid: 0, timedOut: false };
  let terminal = 0;
  let lastActive = nowUs();
  const deadline = Date.now() + INVOCATION_TIMEOUT_MS;
  for (;;) {
    if (Date.now() >= deadline) {
      tally.timedOut = true;
      break;
    }
    await sleep(SETTLE_POLL_MS);
    const seenUs = nowUs();
    for (const raw of readLog().split("\n")) {
      const rec = logRecord(raw.replace(ANSI, ""));
      if (!rec) continue;
      // Without a timestamp, fall back to when it was read (late by at most one poll interval).
      const atUs = rec.atMs === null ? seenUs : monoUsOf(rec.atMs);
      if (rec.message === scenario.enqueued) {
        tally.expected = Number(rec.properties.jobs ?? 0);
        enqueuedUs = atUs;
        continue;
      }
      const job = JOB_LOGS[rec.message];
      if (!job) continue;
      completions.push({
        atUs,
        kind: rec.properties.kind ?? "invalid",
        outcome: job.outcome,
        attempts: rec.properties.attempts ?? null,
      });
      tally[job.outcome]++;
      if (job.terminal) terminal++;
      lastActive = seenUs;
    }
    const allSettled = tally.expected !== null && terminal >= tally.expected;
    if (allSettled && seenUs - lastActive > RUNNER_QUIET_MS * 1000) break;
  }
  return { invocations: alarmSlots(completions, enqueuedUs, settleFromUs), summary: tally };
}

const execFileAsync = promisify(execFile);
const REF_INDEX_SCRIPT = join(WEB_ROOT, "scripts", "ref-index", "refresh.ts");

/** Seeds the perf DB's map using the script GitHub Actions runs. It must spawn the child asynchronously: the fake upstream is in this process, so waiting synchronously would block the event loop and the child's requests would never be answered. Its CPU isn't in any table row (it no longer runs in the Worker, so the free plan's 10ms doesn't apply); only wall time and counts are printed, for reference. */
async function refreshRefIndex(coingeckoBase) {
  const t0 = Date.now();
  const { stdout } = await execFileAsync(
    join(WEB_ROOT, "node_modules", ".bin", "tsx"),
    ["--disable-warning=ExperimentalWarning", REF_INDEX_SCRIPT, "--local", PERF_STATE_DIR],
    { env: { ...process.env, COINGECKO_API_BASE: coingeckoBase }, encoding: "utf8" },
  );
  const summary = stdout.trim().split("\n").join(", ");
  log(`  ref index: ${summary} (${((Date.now() - t0) / 1000).toFixed(1)}s wall, Node)`);
}

/** One trigger: the scheduled request's status code and round trip. `format=json` makes 200/500 map to outcome ok/failed. */
async function fireScheduled(origin, cron) {
  const t0 = nowUs();
  const res = await fetch(
    `${origin}/cdn-cgi/handler/scheduled?${new URLSearchParams({ cron, format: "json" })}`,
    { signal: AbortSignal.timeout(INVOCATION_TIMEOUT_MS) },
  );
  const body = await res.json().catch(() => ({}));
  return { status: res.status, outcome: body.outcome ?? "?", wallMs: (nowUs() - t0) / 1000 };
}

/** Distributes the requests the fake upstream received across slots by call time window (same rule as attribute's sample split). */
// `byRoute` records only slot 0 (the triggered call), counted per "upstream path", so a before/after comparison shows which upstream got extra requests. Paths carrying an address (blockbook) are recorded as-is; accounts are few, so it can not explode.
function fetchesPerSlot(hits, starts) {
  const counts = starts.map(() => 0);
  const byRoute = {};
  for (const h of hits) {
    let slot = -1;
    while (slot + 1 < starts.length && h.atUs >= starts[slot + 1]) slot++;
    if (slot < 0) continue;
    counts[slot]++;
    const route = `${h.upstream} ${h.path}`;
    if (slot === 0) byRoute[route] = (byRoute[route] ?? 0) + 1;
  }
  return { counts, byRoute, errors: hits.filter((h) => h.status >= 400).length };
}

/** Measures one call: (worker stopped) beforeEach, start worker, start sampling, trigger, wait for drain, stop sampling, stop worker. */
async function measureOnce(ctx, scenario, tag) {
  const { opts, workerOpts, fake, runner, userId } = ctx;
  scenario.beforeEach({ userId });
  // The sync-round and runner tables go together: clearing leftover runner jobs (see start below) while leaving an unfinished round means nobody finishes it, so the next cron within the heartbeat sees a live round and posts no `sync-account` (seen: after `--cron-only`, a default run's sweep posted 0 accounts). `--cron-only` never runs jobs, so it always clears.
  if (opts.cronOnly || (runner && !ctx.worker)) clearSyncRounds(userId);
  // The worker restarts every time, so "logged after this start" is all of this call's logs.
  const logFrom = statSync(workerOpts.logFile).size;
  // `--warm`: one worker per scenario, later calls land in the same (hot) isolate; compare with the default to see how much of a call is cold-isolate first-run cost. The runner's SQLite persists with the perf DB, so jobs left unfinished by a previous run (timeout, Ctrl-C, retry backoff) would surface in this one: clear before starting (only possible with the worker stopped; `--warm` clears only before the first start).
  const start = () => {
    if (runner) clearDurableObjectState(runner.className);
    return startWorker({ ...workerOpts, stubRunner: opts.cronOnly });
  };
  ctx.worker ??= opts.warm ? await start() : undefined;
  const w = ctx.worker ?? (await start());
  try {
    const readLog = logCursor(workerOpts.logFile);
    const hitsFrom = fake.hits.length;
    const run = await withCdp(opts, (cdp) =>
      profileWindow(cdp, {
        cpuNs: w.cpuNs,
        trigger: () => fireScheduled(originOf(opts.port), scenario.cron),
        settle: () => settleRunner(opts.cronOnly ? null : runner, readLog, scenario),
      }),
    );
    writeFileSync(join(opts.out, `${scenario.key}-${tag}.cpuprofile`), JSON.stringify(run.profile));
    // Per-call time windows (slot 0 is the cron itself, then one slot per alarm): `analyze.mjs` uses them to split the profile into per-call, per-function top-N.
    writeFileSync(
      join(opts.out, `${scenario.key}-${tag}.slots.json`),
      JSON.stringify({
        scenario: scenario.key,
        beforeStartUs: run.beforeStartUs,
        stopUs: run.stopUs,
        maxSampleUs: opts.samplingUs * COARSE_SAMPLE_FACTOR,
        slots: run.requests.map((r, i) => ({
          startUs: r.startUs,
          kind: i === 0 ? "cron" : r.kind,
        })),
      }),
    );
    // Cap for gap samples (see attribute's maxSampleUs): the cron mostly waits, and uncapped we'd be measuring the wait.
    const a = attribute(run, opts.samplingUs, {
      maxSampleUs: opts.samplingUs * COARSE_SAMPLE_FACTOR,
    });
    const n = run.requests.length;
    const starts = run.requests.map((r) => r.startUs);
    const fetches = fetchesPerSlot(fake.hits.slice(hitsFrom), starts);
    const perSlotMs = a.perRequestCpuMs ?? [a.totalCpuMs];
    const result = scenario.resultOf(readFileFrom(workerOpts.logFile, logFrom), run.settled);
    return {
      tag,
      status: run.triggered.status,
      outcome: run.triggered.outcome,
      result,
      cpuMs: perSlotMs[0],
      totalCpuMs: a.totalCpuMs,
      procCpuMs: run.procCpuMs,
      wallMs: run.triggered.wallMs,
      windowMs: (run.stopUs - run.beforeStartUs) / 1000,
      fetches: fetches.counts[0],
      fetchesByRoute: fetches.byRoute,
      upstreamErrors: fetches.errors,
      alarms: run.requests.slice(1).map((r, i) => ({
        kind: r.kind,
        outcome: r.outcome,
        attempts: r.attempts,
        cpuMs: perSlotMs[i + 1] ?? null,
        fetches: fetches.counts[i + 1],
      })),
      clockAligned: a.aligned,
      coarseShare: a.coarseShare,
      gapMs: a.gapMs,
      gcMs: a.gcMs * n,
      programMs: a.programMs * n,
      samples: a.samples,
      // attribute gives per-slot averages; here we need the whole window's totals.
      owners: a.owners.map((o) => ({ group: o.group, ms: o.ms * n })),
      topModules: a.topModules.map((m) => ({ ...m, ms: m.ms * n })),
    };
  } finally {
    if (!opts.warm) await w.stop();
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Several calls to one table row. owners are averaged across calls (milliseconds per call). */
function rowOf(key, label, runs, { pick = (r) => r.cpuMs } = {}) {
  const cpu = runs.map(pick).filter((x) => x != null);
  const owners = new Map();
  for (const r of runs)
    for (const o of r.owners) owners.set(o.group, (owners.get(o.group) ?? 0) + o.ms);
  const bad = runs.find((r) => r.status !== 200 || !r.result.ok);
  return {
    key,
    label,
    n: runs.length,
    status: bad ? `${bad.status}/${bad.outcome}` : String(runs[0]?.status ?? "—"),
    ok: !bad,
    result: runs[runs.length - 1]?.result.text ?? "",
    meanCpuMs: mean(cpu),
    p50CpuMs: quantile(cpu, 0.5),
    maxCpuMs: cpu.length ? Math.max(...cpu) : null,
    procCpuMs: mean(runs.map((r) => r.procCpuMs).filter((x) => x != null)),
    wallP50Ms: quantile(
      runs.map((r) => r.wallMs),
      0.5,
    ),
    fetches: mean(runs.map((r) => r.fetches)),
    coarseShare: mean(runs.map((r) => r.coarseShare)),
    owners: [...owners]
      .map(([group, ms]) => ({ group, ms: ms / runs.length }))
      .sort((a, b) => b.ms - a.ms),
  };
}

/** The runner rows: all calls and alarms flattened, one row per kind (one sample per alarm). The budget is per call, so what matters is which job's single alarm exceeds it, not the window total. */
function alarmRowsOf(key, runs) {
  const byKind = new Map();
  for (const b of runs.flatMap((r) => r.alarms)) {
    const list = byKind.get(b.kind) ?? [];
    list.push(b);
    byKind.set(b.kind, list);
  }
  return [...byKind]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, batches]) => {
      const cpu = batches.map((b) => b.cpuMs).filter((x) => x != null);
      const ok = batches.every((b) => b.outcome === "done" || b.outcome === "invalid");
      const buried = batches.some((b) => b.outcome === "buried");
      return {
        key: `${key}:alarm:${kind}`,
        label: `runner alarm, ${kind} (per invocation, split by job log timing — approximate)`,
        n: batches.length,
        status: ok ? "done" : buried ? "buried" : "retried",
        ok,
        result: `${(batches.length / runs.length).toFixed(1)} per trigger`,
        meanCpuMs: mean(cpu),
        p50CpuMs: quantile(cpu, 0.5),
        maxCpuMs: cpu.length ? Math.max(...cpu) : null,
        procCpuMs: null,
        // One alarm's wall clock can't be measured locally (see alarmSlots).
        wallP50Ms: null,
        fetches: mean(batches.map((b) => b.fetches)),
        coarseShare: 0,
        owners: [],
      };
    });
}

async function runScenario(ctx, scenario) {
  const reps = ctx.opts.reps ?? scenario.reps;
  log(`${scenario.key} (${scenario.cron}): first invocation`);
  const first = await measureOnce(ctx, scenario, "first");
  log(`  first: ${first.cpuMs?.toFixed(1)} ms CPU, ${first.fetches} fetches, ${first.result.text}`);
  const runs = [];
  for (let i = 1; i <= reps; i++) {
    const r = await measureOnce(ctx, scenario, `rep${i}`);
    log(
      `  rep ${i}/${reps}: ${r.cpuMs?.toFixed(1)} ms CPU, ${r.fetches} fetches, ${r.result.text}`,
    );
    runs.push(r);
  }
  const rows = [rowOf(`${scenario.key}:first`, `${scenario.label} — first after seed`, [first])];
  if (runs.length) rows.push(rowOf(scenario.key, scenario.label, runs));
  if (ctx.runner && !ctx.opts.cronOnly) {
    // The runner rows use only the steady-state calls (the first if none): all CPU behind a trigger, and per-kind per-alarm. The `:first` call's per-kind numbers are in summary.json (cold directory, tokens not yet created, so not comparable with steady state).
    const steady = runs.length ? runs : [first];
    rows.push(
      rowOf(`${scenario.key}:window`, "cron + every runner alarm it caused", steady, {
        pick: (r) => r.totalCpuMs,
      }),
    );
    rows.push(...alarmRowsOf(scenario.key, steady));
  }
  if (ctx.worker) {
    await ctx.worker.stop();
    ctx.worker = undefined;
  }
  return { key: scenario.key, cron: scenario.cron, first, runs, rows };
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  if (opts.help) return void console.log(USAGE);
  if (opts.list) return void console.log(SCENARIO_KEYS.join("\n"));
  const unknown = (opts.only ?? []).filter((k) => !SCENARIO_KEYS.includes(k));
  if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(", ")} — see --list`);
  const scenarios = SCENARIOS.filter((s) => !opts.only || opts.only.includes(s.key));

  checkDevVars();
  mkdirSync(opts.out, { recursive: true });
  const logFile = join(opts.out, "wrangler.log");
  writeFileSync(logFile, "");
  if (opts.build) {
    log("building (vite build)");
    build(logFile);
  }
  log(`migrating perf DB (${PERF_STATE_DIR})`);
  migrate(logFile);

  const fake = await startFakeUpstream({ port: opts.upstreamPort });
  log(`fake upstream on ${fake.origin} ${JSON.stringify(fake.stats())}`);
  try {
    const workerOpts = {
      port: opts.port,
      inspectorPort: opts.inspectorPort,
      logFile,
      vars: fake.vars,
    };
    const { userId, counts } = await prepareData({ ...opts, workerOpts, log });
    const runner = runnerConfig();
    log(
      !runner
        ? `no ${RUNNER_BINDING} durable object configured — measuring scheduled() only`
        : opts.cronOnly
          ? `job runner: ${runner.className} → no-op stub (--cron-only), measuring scheduled() only`
          : `job runner: ${runner.className} (durable object alarms, one job per alarm)`,
    );
    const ctx = { opts, workerOpts, fake, runner, userId };

    // The sweep needs the global ref map (on-chain tokens are recognised through it). If the table is empty (just seeded), refresh it once with the production script (`scripts/ref-index/refresh.ts --local`) against the perf DB, pointed at the fake upstream; the worker is stopped now. Without that script the code under test predates it: the map is refreshed by the daily cron in the Worker, whose first run fills it.
    if (refIndexRowCount() === 0 && !existsSync(REF_INDEX_SCRIPT)) {
      log(
        "global ref index is empty and scripts/ref-index is absent — cron-daily fills it (legacy)",
      );
    } else if (refIndexRowCount() === 0) {
      log(
        "global ref index is empty — refreshing it once with scripts/ref-index (not a Worker job)",
      );
      await refreshRefIndex(fake.vars.COINGECKO_API_BASE);
    }

    const loadBefore = hostLoad();
    const results = [];
    for (const s of scenarios) results.push(await runScenario(ctx, s));
    const loadAfter = hostLoad();

    const rows = results.flatMap((r) => r.rows);
    const summary = {
      at: new Date().toISOString(),
      samplingUs: opts.samplingUs,
      budgetMs: opts.budgetMs,
      dataset: counts ?? "reused (--no-seed)",
      upstream: fake.stats(),
      runner: runner ? { ...runner, stubbed: opts.cronOnly } : "none",
      host: { before: loadBefore, after: loadAfter },
      rows,
      scenarios: results,
    };
    writeFileSync(join(opts.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    // Profile line numbers are valid only for this build: store a region table so `perf:cpu:analyze` can still resolve them later.
    writeFileSync(join(opts.out, "regions.json"), JSON.stringify(snapshotRegions()));
    const title = "cron CPU per invocation, production build under wrangler dev, fake upstream";
    console.log(formatJobsTable(rows, { budgetMs: opts.budgetMs, title }));
    const broken = rows.filter((r) => !r.ok).map((r) => r.key);
    if (broken.length)
      log(`not a clean run for ${broken.join(", ")} — those numbers profile an error path`);
    if (loadBefore.busy) {
      log(
        `host was busy before profiling (load ${loadBefore.load1} on ${loadBefore.cpus} cores) — CPU numbers may be inflated; rerun on a quiet machine before comparing`,
      );
    }
    log(`wrote ${opts.out} (summary.json + *.cpuprofile — open in Chrome DevTools › Performance)`);
  } finally {
    await fake.close();
  }
}

let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  await stopAll();
  process.exit(code);
}
process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));

main()
  .then(() => stopAll())
  .catch(async (err) => {
    console.error(`[perf:jobs] ${err instanceof Error ? err.message : err}`);
    await shutdown(1);
  });
