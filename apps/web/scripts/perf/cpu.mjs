#!/usr/bin/env node
// 每端点的服务端 CPU:构建产物 + wrangler dev + V8 采样 profiler。
//
//   pnpm --filter @folio/web perf:cpu                          # 构建、灌数据、全部端点各 30 发
//   pnpm --filter @folio/web perf:cpu --no-build --only fn-getSnapshots-now,doc-root-authed
//   pnpm --filter @folio/web perf:cpu --cold --only fn-getValuationSettings
//   pnpm --filter @folio/web perf:cpu --list                   # 列出端点名
//
// 为什么要它、怎么读输出:见 scripts/perf/README.md。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_BUDGET_MS,
  DEFAULT_DAYS,
  DEFAULT_INSPECTOR_PORT,
  DEFAULT_PORT,
  DEFAULT_REPS,
  DEFAULT_SAMPLING_US,
  DEFAULT_TOKENS,
  DEFAULT_WARMUP,
  PERF_STATE_DIR,
  PERF_USER,
} from "./constants.mjs";
import { endpointInputs } from "./dataset.mjs";
import { buildEndpoints, ENDPOINT_KEYS } from "./endpoints.mjs";
import {
  attribute,
  hostLoad,
  measureProcessCpu,
  profileEndpoint,
  profileFirstRequest,
  withCdp,
} from "./profiler.mjs";
import { formatTable, quantile } from "./report.mjs";
import { prepareData, signIn } from "./session.mjs";
import { build, checkDevVars, migrate, originOf, startWorker, stopAll } from "./worker.mjs";

const USAGE = `usage: perf:cpu [options]
  --no-build             reuse the existing dist/ (default: vite build first)
  --no-seed              keep the perf DB as is (default: wipe + reseed)
  --only a,b             endpoint keys to profile (see --list)
  --list                 print endpoint keys and exit
  --reps N               requests per endpoint (default ${DEFAULT_REPS})
  --warmup N             unmeasured requests before sampling (default ${DEFAULT_WARMUP})
  --sampling-us N        V8 sampling interval in µs (default ${DEFAULT_SAMPLING_US})
  --budget-ms N          per-request CPU budget (default ${DEFAULT_BUDGET_MS})
  --fail-over-budget     exit 1 if any endpoint's mean CPU exceeds the budget
  --cold                 restart the worker per endpoint and profile its first request
  --accounts N           seeded accounts (default ${DEFAULT_ACCOUNTS})
  --tokens N             seeded tokens (default ${DEFAULT_TOKENS})
  --days N               days of hourly snapshots (default ${DEFAULT_DAYS})
  --port N               worker port (default ${DEFAULT_PORT})
  --inspector-port N     inspector port (default ${DEFAULT_INSPECTOR_PORT})
  --out DIR              output dir (default ${join(PERF_STATE_DIR, "runs", "<timestamp>")})`;

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "no-build": { type: "boolean", default: false },
      "no-seed": { type: "boolean", default: false },
      only: { type: "string" },
      list: { type: "boolean", default: false },
      reps: { type: "string", default: String(DEFAULT_REPS) },
      warmup: { type: "string", default: String(DEFAULT_WARMUP) },
      "sampling-us": { type: "string", default: String(DEFAULT_SAMPLING_US) },
      "budget-ms": { type: "string", default: String(DEFAULT_BUDGET_MS) },
      "fail-over-budget": { type: "boolean", default: false },
      cold: { type: "boolean", default: false },
      accounts: { type: "string", default: String(DEFAULT_ACCOUNTS) },
      tokens: { type: "string", default: String(DEFAULT_TOKENS) },
      days: { type: "string", default: String(DEFAULT_DAYS) },
      port: { type: "string", default: String(DEFAULT_PORT) },
      "inspector-port": { type: "string", default: String(DEFAULT_INSPECTOR_PORT) },
      out: { type: "string" },
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
    reps: Math.max(1, num("reps")),
    warmup: num("warmup"),
    samplingUs: num("sampling-us"),
    budgetMs: num("budget-ms"),
    failOverBudget: values["fail-over-budget"],
    cold: values.cold,
    dataset: { accounts: num("accounts"), tokens: Math.max(1, num("tokens")), days: num("days") },
    port: num("port"),
    inspectorPort: num("inspector-port"),
    out: values.out ?? join(PERF_STATE_DIR, "runs", stamp),
  };
}

const log = (msg) => process.stderr.write(`[perf] ${msg}\n`);

function summarizeRun(endpoint, run, samplingUs) {
  const a = attribute(run, samplingUs);
  const statuses = run.requests.map((r) => r.status);
  const wrong = statuses.find((s) => s !== endpoint.expect);
  return {
    key: endpoint.key,
    label: endpoint.label,
    status: wrong ?? endpoint.expect,
    expect: endpoint.expect,
    reps: run.requests.length,
    meanCpuMs: a.meanCpuMs,
    p50CpuMs: quantile(a.perRequestCpuMs, 0.5),
    maxCpuMs: a.perRequestCpuMs ? Math.max(...a.perRequestCpuMs) : null,
    wallP50Ms: quantile(
      run.requests.map((r) => r.wallMs),
      0.5,
    ),
    bytes: run.requests[0]?.bytes,
    gcMs: a.gcMs,
    programMs: a.programMs,
    outsideMs: a.outsideMs,
    coarseShare: a.coarseShare,
    clockAligned: a.aligned,
    samples: a.samples,
    perRequestCpuMs: a.perRequestCpuMs,
    owners: a.owners,
    topModules: a.topModules,
  };
}

async function profileWarm(opts, workerOpts, endpoints) {
  const w = await startWorker(workerOpts);
  try {
    return await withCdp(opts, async (cdp) => {
      const rows = [];
      for (const e of endpoints) {
        log(`profiling ${e.key} (${opts.reps} reps)`);
        const run = await profileEndpoint(cdp, e, opts);
        writeFileSync(join(opts.out, `${e.key}.cpuprofile`), JSON.stringify(run.profile));
        const procCpuMs = await measureProcessCpu(e, opts.reps, w.cpuNs);
        rows.push({ ...summarizeRun(e, run, opts.samplingUs), procCpuMs });
      }
      return rows;
    });
  } finally {
    await w.stop();
  }
}

// 冷启动:每个端点重起一次 worker。就绪探针走静态资源(不进 worker),否则探针那一发就把
// isolate 暖了,量到的「第一发」其实是第二发。
async function profileCold(opts, workerOpts, endpoints) {
  const rows = [];
  for (const e of endpoints) {
    log(`cold ${e.key}: restarting worker`);
    const w = await startWorker({ ...workerOpts, probePath: "/favicon.ico" });
    try {
      const run = await withCdp(opts, (cdp) => profileFirstRequest(cdp, e));
      writeFileSync(join(opts.out, `cold-${e.key}.cpuprofile`), JSON.stringify(run.profile));
      rows.push(summarizeRun(e, run, opts.samplingUs));
    } finally {
      await w.stop();
    }
  }
  return rows;
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  if (opts.help) return void console.log(USAGE);
  if (opts.list) return void console.log(ENDPOINT_KEYS.join("\n"));

  // 名字拼错要在构建、灌数据之前就报,而不是等一分钟之后。
  const unknown = (opts.only ?? []).filter((k) => !ENDPOINT_KEYS.includes(k));
  if (unknown.length) throw new Error(`unknown endpoint(s): ${unknown.join(", ")} — see --list`);
  checkDevVars();
  mkdirSync(opts.out, { recursive: true });
  const logFile = join(opts.out, "wrangler.log");
  const workerOpts = { port: opts.port, inspectorPort: opts.inspectorPort, logFile };

  if (opts.build) {
    log("building (vite build)");
    build(logFile);
  }
  log(`migrating perf DB (${PERF_STATE_DIR})`);
  migrate(logFile);
  const { userId, counts } = await prepareData({ ...opts, workerOpts, log });

  // 登录要 worker 活着;冷启动模式每端点都会重起,cookie 在 D1 里跨重启有效。
  const origin = originOf(opts.port);
  const w = await startWorker(workerOpts);
  let cookie;
  try {
    cookie = await signIn(origin, PERF_USER);
  } finally {
    await w.stop();
  }
  const endpoints = await buildEndpoints(
    { origin, cookie, ...endpointInputs(userId), now: Date.now() },
    opts.only,
  );

  const loadBefore = hostLoad();
  const rows = opts.cold
    ? await profileCold(opts, workerOpts, endpoints)
    : await profileWarm(opts, workerOpts, endpoints);
  const loadAfter = hostLoad();

  const summary = {
    mode: opts.cold ? "cold" : "warm",
    at: new Date().toISOString(),
    reps: opts.cold ? 1 : opts.reps,
    warmup: opts.cold ? 0 : opts.warmup,
    samplingUs: opts.samplingUs,
    budgetMs: opts.budgetMs,
    dataset: counts ?? "reused (--no-seed)",
    host: { before: loadBefore, after: loadAfter },
    rows,
  };
  writeFileSync(join(opts.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  const title = `${summary.mode} CPU, ${summary.reps} req/endpoint, production build under wrangler dev`;
  console.log(formatTable(rows, { budgetMs: opts.budgetMs, title }));
  const misaligned = rows.filter((r) => !r.clockAligned).map((r) => r.key);
  if (misaligned.length)
    log(`profiler clock not aligned for ${misaligned.join(", ")} — p50/max omitted`);
  const wrongStatus = rows.filter((r) => r.status !== r.expect).map((r) => r.key);
  if (wrongStatus.length)
    log(`unexpected status for ${wrongStatus.join(", ")} — those numbers profile an error path`);
  // 只看开测前的负载:测的时候 workerd 自己就占着一个核,「之后」那个数恒偏高。
  if (loadBefore.busy) {
    log(
      `host was busy before profiling (load ${loadBefore.load1} on ${loadBefore.cpus} cores) — CPU numbers may be inflated; check mean against proc, rerun on a quiet machine before comparing`,
    );
  }
  log(`wrote ${opts.out} (summary.json + *.cpuprofile — open in Chrome DevTools › Performance)`);

  const over = rows.filter((r) => r.meanCpuMs > opts.budgetMs);
  if (opts.failOverBudget && over.length) process.exitCode = 1;
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
    console.error(`[perf] ${err instanceof Error ? err.message : err}`);
    await shutdown(1);
  });
