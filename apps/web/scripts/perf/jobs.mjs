#!/usr/bin/env node
// 后台写路径的 CPU:一次 `scheduled()`(以及它投给运行器的活,如果有)吃多少服务端 CPU。
//
//   pnpm --filter @folio/web perf:cpu:jobs                         # 构建、灌数据、两个 cron 各量一轮
//   pnpm --filter @folio/web perf:cpu:jobs --no-build --only cron-sweep --reps 3
//   pnpm --filter @folio/web perf:cpu:jobs --list
//
// 与 perf:cpu 同一套量法(构建产物 + wrangler dev + V8 采样 + /proc 交叉校验),量的对象换成定时任务:
// wrangler dev 的 `/cdn-cgi/handler/scheduled?cron=…` 进的就是 `scheduled()`,而且**等 waitUntil
// 跑完才答**,所以一次触发 = 一次完整的 cron 调用。上游全换成本机假上游(fake-upstream.mjs)——
// 沙箱出网被挡,而这条路每一步都要出网。
//
// **每一次都重起 worker**(isolate 是新的,模块已由就绪探针求值过):生产的整点 cron 隔着一小时,
// 多半落在一个没热过这条路径的 isolate 上;连着在同一个 isolate 里触发,第二次起 JIT 与模块级缓存
// (Rabby 的链表、各家的闸)都是热的,量小了。重起之间还把代币价标成过期,理由见 expirePrices。
//
// 运行器(FOL-100 起两个 cron 都只投活,真活在 `JobRunner` 这个 DO 的 alarm 里、一次 alarm 一件):
// 一次触发之后接着等**它投的每一件活**都跑完(cron 那行日志报了投几件,consumer 每件收尾打一行带 kind
// 的日志),再等一段安静(接力投的后续活)。**本地 alarm 没有逐次调用的日志行**(队列时代有 miniflare 的
// `QUEUE <name> a/b (Nms)`;alarm 由 workerd 自己调度,wrangler dev 什么都不打),所以按 app 自己的
// 收尾行切:一件活那一格 = 上一件收尾(第一件从 cron 投完那行起)到它自己收尾,见 alarmSlots。
// DO 与 worker 同一个 isolate,采样器看得见它。构建产物里没有 JOB_RUNNER 这个 DO 绑定 → 这一截整个跳过。
//
// 为什么要它、怎么读输出:见 scripts/perf/README.md。
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

/**
 * 被测的定时任务。表达式与 wrangler.jsonc 的 `triggers.crons` 一一对应(server.ts 按它分支)。
 * `beforeEach`:每次触发前(worker 停着)对库做的事,让这一次看到的状态像生产那一次。
 * `resultOf`:从这次调用的日志里读出「它干成了什么」—— 量到的若是报错路径,数字作废。
 */
const SCENARIOS = [
  // 两条都只投活:`enqueued` 是 cron 投完那行日志的 message,它的 `jobs` 字段 = 投了几件 —— 等运行器
  // 跑空时就等这么多件收尾(`settleRunner`)。
  //
  // 每天那条只投活(prune-notes / catalogue,FOL-88)。**全局映射表不在这里刷了**(FOL-85):它挪到了
  // GitHub Actions 里的 Node 脚本,不再吃 Worker 的预算,所以这里没有 `cron-ref-index` 那一格了。
  // 那个脚本的耗时见下面 `refreshRefIndex`(sweep 要一张非空的表,灌数据后先跑它一次)。
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
  // 整点 sweep(FOL-86):cron 那一次只开轮 + 投消息;每个账户一条 `sync-account`,每个用户再补
  // `hourlyUserJobs`(prices / daily-prices / fx 立即,platforms / defi-logos 延后 120s —— 所以跑空
  // 不能只靠「安静了几秒」,要等投的件数收完)。**干成没有**看两处:每一轮的收官日志
  // (`queued round done`,最后一件 sync-account 打)里 synced == total,以及每件活都 done 了。
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
        // `--cron-only`:没等运行器(`settled.summary` 为空),只看 cron 自己投成了没有。
        ok:
          done.failed === 0 &&
          (!settled?.summary || (rounds.length > 0 && synced === total && drained.ok)),
        text: `synced ${synced}/${total}, ${drained.text}`,
        detail: { ...done, rounds, runner: settled?.summary },
      };
    },
  },
];

/**
 * 扇出之前(FOL-86 / FOL-88 之前)的代码没有「enqueued」那行:cron 自己把活干完,收尾各打一行。
 * 留着它们,是为了拿同一个 harness 量改动前的那份代码做前后对比(那时每天那条还在 Worker 里刷映射表)。
 */
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

/** 运行器那半干成没有:投的每一件都收尾了、没有一件埋掉 / 解不开。没有运行器 → 不判。 */
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

/** 一次触发最多等多久(cron 自己有闸在排队,首轮要翻目录、写几万行)。 */
const INVOCATION_TIMEOUT_MS = 10 * 60_000;
/**
 * 运行器跑空的判据:cron 投的件数都收尾了之后,再这么久没有新的收尾日志(接力投的后续活 ——
 * `prices` 超预算拆件、`daily-prices` 补不完再投一件 —— 不带延迟,落在这段安静里)。
 */
const RUNNER_QUIET_MS = 2_000;
/** 运行器的 DO 绑定名(wrangler.jsonc `durable_objects`,`jobs/queue.ts` 按它取)。 */
const RUNNER_BINDING = "JOB_RUNNER";
/**
 * consumer 每件活的收尾日志(`jobs/consume.ts`,都带 `kind`)。`terminal`:这件活不会再跑了。
 * 运行器只在「收尾那一步自己没跑成」时另打一行(`job give-up could not run`),不单列 —— 它前面必有一行埋掉的记录。
 * 每一行也是**一次 alarm 的终点**(一次 alarm 只跑一件,`jobs/runner.ts`),切格就靠它,见 alarmSlots。
 */
const JOB_LOGS = {
  "job done": { terminal: true, outcome: "done" },
  "job failed, will retry": { terminal: false, outcome: "retried" },
  "job failed on final attempt, burying it": { terminal: true, outcome: "buried" },
  "job never finished its final attempt, burying it": { terminal: true, outcome: "buried" },
  "invalid job dropped": { terminal: true, outcome: "invalid" },
};
/** 跑空轮询的间隔。 */
const SETTLE_POLL_MS = 50;
/**
 * 日志时间戳(LogTape JSON 行的 `@timestamp`,墙钟毫秒)→ 本机单调时钟(微秒,profile 用的那个)。
 * 两边同一台机器,差一个常数;起跑时量一次。精度是毫秒,且 workerd 的 `Date.now()` 只在 I/O 边界前进 ——
 * 收尾行紧跟在一件活最后一次 I/O 之后打,所以记下的时刻 ≈ 那件活真的收尾的时刻(之后那点同步 CPU 落进下一格)。
 */
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

/** 从某个偏移起读日志文件到末尾。wrangler 往里追加,我们只读。 */
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

/** 日志的增量读者:每次调用返回上次之后新写进来的部分(跑空时认收尾行用)。 */
function logCursor(file) {
  let offset = statSync(file).size;
  return () => {
    const text = readFileFrom(file, offset);
    offset += Buffer.byteLength(text);
    return text;
  };
}

/**
 * 一行日志若是 LogTape 的 JSON 行(生产格式,JSON Lines)→ `{ message, properties, atMs }`;否则 undefined。
 * `atMs`:`@timestamp` 的墙钟毫秒(没有 / 解不开 → null)。
 */
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
    return undefined; // 半行 / 不是 JSON —— 跳过
  }
}

/** 日志里某条消息的**全部**记录的 properties,按出现顺序。 */
function logEvents(text, message) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.includes(`"${message}"`)) continue;
    const rec = logRecord(line);
    if (rec?.message === message) out.push(rec.properties);
  }
  return out;
}

/** 日志里某条消息的最后一条记录的 properties;没有 → undefined。 */
function logEvent(text, message) {
  return logEvents(text, message).at(-1);
}

/** 构建产物里的运行器(`durable_objects` 里绑成 JOB_RUNNER 的那个类)。没有 → null,整段运行器逻辑跳过。 */
function runnerConfig() {
  const binding = builtConfig().durable_objects?.bindings?.find((b) => b.name === RUNNER_BINDING);
  return binding ? { binding: binding.name, className: binding.class_name } : null;
}

/**
 * 把收尾行切成逐 alarm 的格。**本地没有 alarm 自己的起止**(workerd 调度 alarm 时 wrangler dev 一行都不打,
 * 实测;队列时代靠的 `QUEUE …` 行没有对应物),能用的只有 app 自己的收尾行 —— 一次 alarm 只跑一件
 * (`jobs/runner.ts`),所以一行收尾 = 一次 alarm 的终点:
 *   第 k 格 = [第 k−1 件收尾, 第 k 件收尾),第一格从 cron 投完那行(`enqueuedUs`)起。
 * 于是一格里除了这件活,还有上一次 alarm 收尾之后那点尾巴(ack 删行、再定 alarm)与这一次 alarm 进门的
 * 开销 —— 都是「一次 alarm」该付的,只是记错了一格,量级在亚毫秒。中间的空等(延后 120s 的活、重试退避)
 * 不进 CPU:isolate 闲着时采样器是停的,恢复后那个样本按 maxSampleUs 封顶,与 cron 一格同一个口径。
 * cron 本身在投完之后还有一小截(`pokeRunner`),落在第一格;sweep 多用户时逐用户投活,前面用户的活会与
 * 后面用户的投活交错 —— 那样的话逐 kind 是**近似**,整段窗口的总数是准的。
 */
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
        // 两次收尾之间的墙钟不是这次 alarm 的墙钟(可能含 120s 的延后),不报。
        wallMs: null,
        alarm: true,
      };
    });
}

/**
 * 触发一次之后等运行器把这次投的活跑完。没运行器(或 `--cron-only`)→ 立刻返回(scheduled 那一发答了就是跑完了)。
 *
 * 有运行器 → 边读日志边记两样,**按日志里出现的顺序**:
 *   · cron 投完那一行(`scenario.enqueued`)的 `jobs` —— 要等收尾的件数,和它的时间戳(第一格的起点);
 *   · consumer 每件活的收尾行(`JOB_LOGS`)—— kind、下场、时间戳(这一格的终点)。
 * 停下来的条件:收尾的件数 ≥ 投的件数,**并且**之后 RUNNER_QUIET_MS 内没有新的收尾行。
 * 只靠「安静了几秒」是不够的 —— `platforms` / `defi-logos` 延后 120s 才到点,中间整段是安静的。
 * 不拿 workerd 的 CPU 判「安静」:开着采样器的 workerd 空转本身每 50ms 就有 5–10ms CPU、还上下抖。
 */
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
      // 时间戳缺了就退回「读到它的时刻」(晚最多一个轮询间隔)。
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

/**
 * 用 GitHub Actions 里跑的那个脚本灌 perf 库的映射表(FOL-85)。**必须异步起子进程**:假上游就在本进程里,
 * 同步等子进程会把事件循环堵死,子进程的请求永远等不到答复。它的 CPU 不进任何一行表 —— 它不在
 * Worker 里跑了,免费计划的 10ms 管不到它;这里只把墙钟与计数打出来,方便对照。
 */
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

/** 一次触发:scheduled 那一发的状态码与往返时间。`format=json` → 200/500 对应 outcome ok/失败。 */
async function fireScheduled(origin, cron) {
  const t0 = nowUs();
  const res = await fetch(
    `${origin}/cdn-cgi/handler/scheduled?${new URLSearchParams({ cron, format: "json" })}`,
    { signal: AbortSignal.timeout(INVOCATION_TIMEOUT_MS) },
  );
  const body = await res.json().catch(() => ({}));
  return { status: res.status, outcome: body.outcome ?? "?", wallMs: (nowUs() - t0) / 1000 };
}

/** 把假上游收到的请求按调用的时间窗分给各格(与 attribute 拆采样同一个规则)。 */
// `byRoute` 只记第 0 格(被触发的那次调用)、按「上游 路径」计数 —— 前后对比时一眼看出是哪一家
// 多打了几发。路径里带地址的(blockbook)照记,账户少,不会炸。
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

/**
 * 量一次调用:(worker 停着)beforeEach → 起 worker → 开采样 → 触发 → 等排空 → 停采样 → 停 worker。
 */
async function measureOnce(ctx, scenario, tag) {
  const { opts, workerOpts, fake, runner, userId } = ctx;
  scenario.beforeEach({ userId });
  // 同步轮与运行器的表是一对:清了表里剩下的活(见下面 start),没收官的轮就再没人收 —— 下一次 cron 在
  // 心跳期内看到「活轮还在」就不投 `sync-account`(踩过:`--cron-only` 之后接着跑默认口径,sweep 投了 0 个账户)。
  // `--cron-only` 本来就不跑活,每次都清。
  if (opts.cronOnly || (runner && !ctx.worker)) clearSyncRounds(userId);
  // 每次都重起 worker,所以「这次启动之后写进日志的」就是这次调用的全部日志。
  const logFrom = statSync(workerOpts.logFile).size;
  // `--warm`:一个场景一个 worker,后面几次落在同一个(热的)isolate 上 —— 与默认口径对照,
  // 就知道一次调用里有多少是冷 isolate 的首跑开销。
  // 运行器的 SQLite 跟着 perf 库落盘,上一次没跑完的活(超时、Ctrl-C、重试退避)会在这一次里冒出来 ——
  // 起之前清掉(worker 停着才能清;`--warm` 只在第一次起之前清)。
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
    // 每次调用的时间窗(第 0 格是 cron 本身,其后每次 alarm 一格):`analyze.mjs` 靠它把
    // profile 拆成逐调用、逐函数的 top-N。
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
    // 空档样本封顶(见 attribute 的 maxSampleUs):cron 大半时间在等,不封顶的话量到的是等待。
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
      // attribute 给的是「每格平均」,这里要整段窗口的总数。
      owners: a.owners.map((o) => ({ group: o.group, ms: o.ms * n })),
      topModules: a.topModules.map((m) => ({ ...m, ms: m.ms * n })),
    };
  } finally {
    if (!opts.warm) await w.stop();
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** 多次调用 → 表里一行。owners 取各次的平均(每次调用多少毫秒)。 */
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

/**
 * 运行器那几行:所有次、所有 alarm 摊平,**按 kind 一行**(每次 alarm 一个样本)。预算是按一次调用算的,
 * 所以要看的是「哪件活的一次 alarm」超了,不是整段的总数。
 */
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
        // 一次 alarm 的墙钟本地量不到(见 alarmSlots)。
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
    // 运行器那几行只看稳态那几次(没有就看第一次):一次触发背后的全部 CPU,与逐 kind 的每次 alarm。
    // `:first` 那一次的逐 kind 在 summary.json 里(目录冷、代币没建行,与稳态不是一回事)。
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

    // sweep 要全局映射表(链上的币靠它认)。表是空的(刚灌过数据)就先刷一次 —— 用生产那个脚本
    // (`scripts/ref-index/refresh.ts --local`,FOL-85),对着 perf 库、指到假上游。worker 此刻是停着的。
    // 没有那个脚本 = 被测的是 FOL-85 之前的代码:映射表由每天那条 cron 在 Worker 里刷,
    // cron-daily 排在 sweep 前面,它的第一次就把表灌满了。
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
    // profile 的行号只对这次构建有效 —— 存一份 region 表,`perf:cpu:analyze` 以后照样认得出来。
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
