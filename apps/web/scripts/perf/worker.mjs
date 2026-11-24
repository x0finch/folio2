// The worker under test: build output + `wrangler dev`, plus its env vars and local DB. It measures `dist/server`, what `wrangler deploy` ships (run_worker_first, asset routing included), not `vite dev`'s per-module transpile, whose shape differs from production.
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
  DIST_SERVER_DIR,
  HOST,
  PERF_STATE_DIR,
  READY_POLL_MS,
  READY_TIMEOUT_MS,
  STOP_GRACE_MS,
  WEB_ROOT,
} from "./constants.mjs";

const BIN = join(WEB_ROOT, "node_modules", ".bin");
const DEV_VARS = join(WEB_ROOT, ".dev.vars");
const BUILT_CONFIG = join(DIST_SERVER_DIR, "wrangler.json");

/** Without these auth can't start (BETTER_AUTH_URL is rewritten to the perf port by writeDevVars). */
const REQUIRED_VARS = ["BETTER_AUTH_SECRET", "SECRETS_KEY"];
/** Local-dev-only variables that change the behaviour under test are left out of perf, notably logging: `.dev.vars.example` has `LOG_LEVEL=debug` + `LOG_PRETTY=true`, and coloured debug logs cost real CPU that production doesn't. The wrangler config's `vars` (production values) apply instead. */
const DEV_ONLY_VARS = new Set(["LOG_LEVEL", "LOG_PRETTY", "TUNNEL_NAME", "TUNNEL_HOSTNAME"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The perf worker's origin. An IP, not `localhost`: Node's fetch tries ::1 first for localhost while wrangler listens only on 127.0.0.1, adding a failed connection per request and muddying wall time. */
export const originOf = (port) => `http://${HOST}:${port}`;

/** Reads .dev.vars into a [key, value] list. Parses only; never prints a value. */
function parseDevVars(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    });
}

/** A missing .dev.vars or key exits immediately with what's needed. */
export function checkDevVars() {
  let text;
  try {
    text = readFileSync(DEV_VARS, "utf8");
  } catch {
    throw new Error(
      `missing ${DEV_VARS}\n  copy .dev.vars.example and fill in ${REQUIRED_VARS.join(", ")} (see scripts/perf/README.md)`,
    );
  }
  const keys = new Set(parseDevVars(text).map(([k]) => k));
  const missing = REQUIRED_VARS.filter((k) => !keys.has(k));
  if (missing.length) throw new Error(`${DEV_VARS} is missing: ${missing.join(", ")}`);
  return text;
}

/** One .dev.vars value (for seeding scripts, e.g. SECRETS_KEY). Never printed. */
export function devVar(key) {
  return parseDevVars(checkDevVars()).find(([k]) => k === key)?.[1];
}

/** Writes a `.dev.vars` next to the build output (wrangler reads it beside the config). `vite build` copies one too but it disappears between runs (without it BETTER_AUTH_URL is undefined and every auth call 500s), so rewrite before each start. BETTER_AUTH_URL becomes the perf origin: better-auth's CSRF and passkey rpID check it and it must match the accessed origin exactly. */
// `vars`: extra overrides (perf:cpu:jobs points upstream base URLs at the local fake). They win over same-named entries, so even real keys in .dev.vars get swapped for fakes and go nowhere.
function writeDevVars(port, vars = {}) {
  const kept = parseDevVars(checkDevVars()).filter(
    ([k]) => !DEV_ONLY_VARS.has(k) && k !== "BETTER_AUTH_URL" && !(k in vars),
  );
  const lines = [
    ...kept.map(([k, v]) => `${k}=${v}`),
    ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
    `BETTER_AUTH_URL=${originOf(port)}`,
  ];
  writeFileSync(join(DIST_SERVER_DIR, ".dev.vars"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

function run(cmd, args, { logFile, env } = {}) {
  const fd = logFile ? openSync(logFile, "a") : "inherit";
  try {
    const res = spawnSync(join(BIN, cmd), args, {
      cwd: WEB_ROOT,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, ...env },
    });
    if (res.status !== 0) {
      throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status}) — see ${logFile}`);
    }
  } finally {
    if (typeof fd === "number") closeSync(fd);
  }
}

/** Name of the worker standing in for the runner under `--cron-only` (the second `-c`, see stubRunnerConfigs). */
const RUNNER_STUB_NAME = "folio-perf-runner-stub";
/** Stand-in for the runner DO: accepts and pokes but stores nothing and sets no alarm. Shaped after `enqueue` / `poke` in `jobs/durable.ts` (the only methods the RPC side uses). */
const RUNNER_STUB_SOURCE = `import { DurableObject } from "cloudflare:workers";
export class JobRunner extends DurableObject {
  async enqueue() {}
  async poke() { return { pending: 0, dead: 0 }; }
}
export default { fetch: () => new Response(null, { status: 404 }) };
`;

/** For `perf:cpu:jobs --cron-only`: measure only the cron invocation. Alarms can't be disabled (workerd schedules them), so JOB_RUNNER binds to an empty-shell DO in another worker (`script_name`): the cron still posts work over RPC (caller-side serialisation counts) but nobody runs it, so it doesn't overlap the cron's sampling window. The shell is in another isolate the sampler can't see; the /proc column still counts it (one RPC, negligible). Both configs sit beside `wrangler.json` so relative paths (`main` etc.) and `.dev.vars` still resolve. Returns the `-c` order: first is the main worker (it owns the inspector and `--port`). */
function stubRunnerConfigs() {
  const config = builtConfig();
  const main = join(DIST_SERVER_DIR, "wrangler.cron-only.json");
  const stub = join(DIST_SERVER_DIR, "wrangler.runner-stub.json");
  writeFileSync(join(DIST_SERVER_DIR, "runner-stub.mjs"), RUNNER_STUB_SOURCE);
  const bindings = config.durable_objects?.bindings ?? [];
  writeFileSync(
    stub,
    JSON.stringify(
      {
        name: RUNNER_STUB_NAME,
        main: "runner-stub.mjs",
        compatibility_date: config.compatibility_date,
        durable_objects: {
          bindings: bindings.map(({ name, class_name }) => ({ name, class_name })),
        },
        migrations: config.migrations,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    main,
    JSON.stringify(
      {
        ...config,
        durable_objects: {
          bindings: bindings.map((b) => ({ ...b, script_name: RUNNER_STUB_NAME })),
        },
      },
      null,
      2,
    ),
  );
  return [main, stub];
}

/** Clears a DO class's local storage in the perf DB (Miniflare persists to `<persist>/v3/do/<worker name>-<class name>/`). Call with the worker stopped; perf:cpu:jobs uses it to clear leftover runner-table jobs. */
export function clearDurableObjectState(className) {
  rmSync(join(PERF_STATE_DIR, "v3", "do", `${builtConfig().name}-${className}`), {
    recursive: true,
    force: true,
  });
}

/** The built wrangler.json (what `wrangler deploy` ships). */
export function builtConfig() {
  return JSON.parse(readFileSync(BUILT_CONFIG, "utf8"));
}

export function build(logFile) {
  run("vite", ["build"], { logFile });
}

/** Migrates the perf DB from apps/web/wrangler.jsonc's migrations dir; the build's migrations_dir is relative and wouldn't resolve from dist/server. */
export function migrate(logFile) {
  mkdirSync(PERF_STATE_DIR, { recursive: true });
  const { d1_databases: dbs } = builtConfig();
  const name = dbs?.[0]?.database_name;
  if (!name) throw new Error(`no d1 database in ${BUILT_CONFIG}`);
  // CI=1: otherwise wrangler stops to ask "really migrate?".
  run("wrangler", ["d1", "migrations", "apply", name, "--local", "--persist-to", PERF_STATE_DIR], {
    logFile,
    env: { CI: "1" },
  });
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Cumulative on-CPU time across all workerd threads in a process group (nanoseconds, first column of /proc/<pid>/task/<tid>/schedstat). Kernel accounting, not sampling, so accurate even when the sampler thread is starved by other processes. null without /proc (non-Linux). */
function groupCpuNs(pgid) {
  let pids;
  try {
    pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  let total = 0;
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      // After `)`: state ppid pgrp ...
      const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      if (comm !== "workerd" || pgrp !== pgid) continue;
      for (const tid of readdirSync(`/proc/${pid}/task`)) {
        total += Number(readFileSync(`/proc/${pid}/task/${tid}/schedstat`, "utf8").split(" ")[0]);
      }
    } catch {
      // The process exited mid-read.
    }
  }
  return total;
}

const running = new Set();

/** Default readiness probe: enters the worker and reads D1; a 200 means auth and the DB both work. */
const READY_PROBE_PATH = "/api/auth/get-session";

/** Starts `wrangler dev` and returns { stop() } once `probePath` answers. Started as its own process group (detached) so stop signals the whole group; workerd children hang under wrangler. */
export async function startWorker({
  port,
  inspectorPort,
  logFile,
  probePath = READY_PROBE_PATH,
  vars,
  stubRunner = false,
}) {
  for (const p of [port, inspectorPort]) {
    if (await portInUse(p))
      throw new Error(`port ${p} is already in use — pass --port / --inspector-port`);
  }
  writeDevVars(port, vars);
  const fd = openSync(logFile, "a");
  const child = spawn(
    join(BIN, "wrangler"),
    [
      "dev",
      ...(stubRunner ? stubRunnerConfigs() : [BUILT_CONFIG]).flatMap((c) => ["--config", c]),
      "--ip",
      HOST,
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      PERF_STATE_DIR,
      "--show-interactive-dev-session=false",
    ],
    { cwd: WEB_ROOT, stdio: ["ignore", fd, fd], detached: true },
  );
  closeSync(fd);
  let exited = null;
  const done = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  done.then((code) => {
    exited = code ?? "signal";
  });

  const signalGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // Already exited.
    }
  };
  const handle = {
    async stop() {
      running.delete(handle);
      if (exited !== null) return;
      signalGroup("SIGTERM");
      const timer = sleep(STOP_GRACE_MS).then(() => "timeout");
      if ((await Promise.race([done, timer])) === "timeout") {
        signalGroup("SIGKILL");
        await done;
      }
    },
    killNow: () => signalGroup("SIGKILL"),
    cpuNs: () => groupCpuNs(child.pid),
  };
  running.add(handle);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  const probe = `http://${HOST}:${port}${probePath}`;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`wrangler dev exited (${exited}) — see ${logFile}`);
    const status = await probeStatus(probe, originOf(port));
    if (status !== null && status < 500) return handle;
    // A 5xx mostly means a bad .dev.vars: report immediately rather than wait for the timeout.
    if (status !== null) {
      await handle.stop();
      throw new Error(`worker answered ${status} on ${probe} — check .dev.vars; log: ${logFile}`);
    }
    await sleep(READY_POLL_MS);
  }
  await handle.stop();
  throw new Error(`wrangler dev not ready after ${READY_TIMEOUT_MS}ms — see ${logFile}`);
}

/** Probes once; null if still unreachable. */
async function probeStatus(url, origin) {
  try {
    const res = await fetch(url, { headers: { origin } });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return null;
  }
}

/** Stops every worker still running on exit (normal, error, Ctrl-C). */
export async function stopAll() {
  await Promise.all([...running].map((h) => h.stop()));
}

// Synchronous fallback: the `exit` event can't await, so SIGKILL directly.
process.once("exit", () => {
  for (const h of running) h.killNow();
});
