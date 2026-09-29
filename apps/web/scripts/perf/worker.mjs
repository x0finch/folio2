// 被测的 worker:构建产物 + `wrangler dev`,外加它需要的环境变量与本地库。
//
// 测的是 `dist/server` —— `wrangler deploy` 原样发出去的那份(含 run_worker_first、资源路由),
// 不是 `vite dev` 的逐模块转译:后者的形状和线上不是一回事。
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

/** 没有它们 auth 起不来(BETTER_AUTH_URL 由本脚本按 perf 端口改写,见 writeDevVars)。 */
const REQUIRED_VARS = ["BETTER_AUTH_SECRET", "SECRETS_KEY"];
/**
 * 只给本地开发用、会改变**被测行为**的变量 —— 不带进 perf。尤其是日志:`.dev.vars.example`
 * 里是 `LOG_LEVEL=debug` + `LOG_PRETTY=true`,每条彩色 debug 日志都是实打实的 CPU,线上没有。
 * 去掉之后生效的是 wrangler 配置里的 `vars`(生产值)。
 */
const DEV_ONLY_VARS = new Set(["LOG_LEVEL", "LOG_PRETTY", "TUNNEL_NAME", "TUNNEL_HOSTNAME"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * perf worker 的 origin。用 IP 而不是 `localhost`:Node 的 fetch 对 localhost 会先试 ::1,
 * 而 wrangler 只听 127.0.0.1 —— 每发多一次失败的连接尝试,量到的 wall 就不干净。
 */
export const originOf = (port) => `http://${HOST}:${port}`;

/** 读 .dev.vars 成 [key, value] 列表。只解析,不打印任何值。 */
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

/** 缺 .dev.vars 或缺键 → 直接退出,说清楚要什么。 */
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

/** .dev.vars 里某一项的值(给灌数据的脚本用,如 SECRETS_KEY)。不打印。 */
export function devVar(key) {
  return parseDevVars(checkDevVars()).find(([k]) => k === key)?.[1];
}

/**
 * 给构建产物写一份 `.dev.vars`(wrangler 从配置文件旁边读它)。`vite build` 也会拷一份过去,
 * 但它会在两次运行之间消失(踩过:没了它 BETTER_AUTH_URL 是 undefined,每个 auth 调用 500),
 * 所以每次起之前都重写。BETTER_AUTH_URL 改成 perf 自己的 origin —— better-auth 的 CSRF 与
 * passkey rpID 都按它校验,和实际访问的 origin 必须逐字一致。
 */
//
// `vars`:额外的覆盖(perf:cpu:jobs 用它把各家上游的 base URL 指到本机假上游)。同名的一律以它为准,
// 所以 .dev.vars 里就算有真 key,也跟着被换成假的,不会被带去任何地方。
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

/** `--cron-only` 顶替运行器的那个 worker 的名字(第二个 `-c`,见 stubRunnerConfigs)。 */
const RUNNER_STUB_NAME = "folio-perf-runner-stub";
/**
 * 顶替运行器的 DO:收活、戳一下都照答,什么都不存、不定 alarm。形状对着 `jobs/durable.ts` 的
 * `enqueue` / `poke`(RPC 那头只看这两个方法)。
 */
const RUNNER_STUB_SOURCE = `import { DurableObject } from "cloudflare:workers";
export class JobRunner extends DurableObject {
  async enqueue() {}
  async poke() { return { pending: 0, dead: 0 }; }
}
export default { fetch: () => new Response(null, { status: 404 }) };
`;

/**
 * `perf:cpu:jobs --cron-only` 用:只量 cron 那一次调用。alarm 关不掉(workerd 自己调度,到点就响),
 * 所以把 JOB_RUNNER 绑到**另一个 worker** 里的空壳 DO 上(`script_name`)—— cron 照样走 RPC 投活
 * (调用方那一侧的序列化照算),投的活却没人跑,不会和 cron 叠在同一个采样窗里。空壳在另一个 isolate,
 * 采样器看不见它;/proc 那一格照算(它只收一次 RPC,可忽略)。
 * 两份配置都写在 `wrangler.json` 旁边,相对路径(`main` 等)与 `.dev.vars` 照旧对得上。
 * 返回 `-c` 的顺序:第一个是主 worker(inspector 与 `--port` 都归它)。
 */
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

/**
 * 清掉某个 DO 类在 perf 库里的本地存储(Miniflare 按 `<persist>/v3/do/<worker 名>-<类名>/` 落盘)。
 * worker 停着时调 —— perf:cpu:jobs 用它把运行器表里上一次剩下的活清掉。
 */
export function clearDurableObjectState(className) {
  rmSync(join(PERF_STATE_DIR, "v3", "do", `${builtConfig().name}-${className}`), {
    recursive: true,
    force: true,
  });
}

/** 构建出的 wrangler.json(`wrangler deploy` 发的就是它)。 */
export function builtConfig() {
  return JSON.parse(readFileSync(BUILT_CONFIG, "utf8"));
}

export function build(logFile) {
  run("vite", ["build"], { logFile });
}

/**
 * 按 apps/web/wrangler.jsonc 的迁移目录迁 perf 库 —— 构建产物里的 migrations_dir 是相对路径,
 * 从 dist/server 算过去指不对。
 */
export function migrate(logFile) {
  mkdirSync(PERF_STATE_DIR, { recursive: true });
  const { d1_databases: dbs } = builtConfig();
  const name = dbs?.[0]?.database_name;
  if (!name) throw new Error(`no d1 database in ${BUILT_CONFIG}`);
  // CI=1:wrangler 否则会停下来问「确定要迁吗」。
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

/**
 * 一个进程组里所有 workerd 线程累计的上 CPU 时间(纳秒,/proc/<pid>/task/<tid>/schedstat 首列)。
 * 这是内核记的账,不靠采样 —— 采样线程被别的进程饿着的时候它照样准。没有 /proc(非 Linux)→ null。
 */
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
      // `)` 之后:state ppid pgrp …
      const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      if (comm !== "workerd" || pgrp !== pgid) continue;
      for (const tid of readdirSync(`/proc/${pid}/task`)) {
        total += Number(readFileSync(`/proc/${pid}/task/${tid}/schedstat`, "utf8").split(" ")[0]);
      }
    } catch {
      // 进程在读的中途退了
    }
  }
  return total;
}

const running = new Set();

/** 默认的就绪探针:进 worker、读 D1 —— 答 200 就说明 auth 与库都通了。 */
const READY_PROBE_PATH = "/api/auth/get-session";

/**
 * 起 `wrangler dev`,等到 `probePath` 能答再返回。返回 { stop() }。
 * 以独立进程组起(detached),停的时候整组发信号 —— wrangler 底下还挂着 workerd 子进程。
 */
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
      // 已经退了
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
    // 5xx 多半是 .dev.vars 不对 —— 直接报,别等超时。
    if (status !== null) {
      await handle.stop();
      throw new Error(`worker answered ${status} on ${probe} — check .dev.vars; log: ${logFile}`);
    }
    await sleep(READY_POLL_MS);
  }
  await handle.stop();
  throw new Error(`wrangler dev not ready after ${READY_TIMEOUT_MS}ms — see ${logFile}`);
}

/** 探一次;还连不上 → null。 */
async function probeStatus(url, origin) {
  try {
    const res = await fetch(url, { headers: { origin } });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return null;
  }
}

/** 退出(正常、出错、Ctrl-C)时把还开着的 worker 全停掉。 */
export async function stopAll() {
  await Promise.all([...running].map((h) => h.stop()));
}

// 同步兜底:`exit` 事件里不能 await,只能直接 SIGKILL。
process.once("exit", () => {
  for (const h of running) h.killNow();
});
