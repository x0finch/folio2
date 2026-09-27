// V8 采样 profiler,经 workerd 的 inspector(CDP)从外面量。
//
// 为什么不在 worker 里用 `performance.now()`:workerd 里那个时钟在同步计算期间**不走**(防计时
// 侧信道),只在 I/O 边界前进。于是 `withServerFnTiming` 记下的 durationMs 只看得见 I/O 等待,
// 看不见 CPU —— FOL-40 就是按它排的序,排错了。采样 profiler 在 V8 里按真实时间打点,不受影响。
import { WebSocket } from "ws";
import { NON_CPU_FRAMES, ownerOf } from "./owners.mjs";

/** workerd 的 inspector 代理不收没有 `Origin` 头的升级请求(HTTP 400 "Expected Origin header")。 */
const INSPECTOR_ORIGIN = "http://127.0.0.1";
/** 一条 CDP 命令等回应的上限。`Profiler.stop` 的回应几 MB,正常一秒内回来。 */
const CDP_TIMEOUT_MS = 60_000;
/** 单条 CDP 消息的上限。一份 30 发的 profile 回应实测 4 MB 上下,留足余量。 */
const CDP_MAX_MESSAGE_BYTES = 512 * 1024 * 1024;
/** profile 起点与本机单调时钟之间允许的偏差(微秒)。超了就说明两边不是同一个钟,见 attribute。 */
const CLOCK_SKEW_TOLERANCE_US = 50_000;
/**
 * 采样间隔超过设定值的这么多倍,就算「稀疏样本」。实测 isolate 闲着时采样会停,恢复后的第一个
 * 样本带着整段空档(几毫秒)记在当时那一帧上 —— 总数大体仍对(CPU 约为 wall 的八成,与最初
 * 那轮测量一致),但落到哪一发请求上就是碰运气。便宜的端点这种样本占比高,见 coarseShare。
 */
const COARSE_SAMPLE_FACTOR = 10;

const nowUs = () => Number(process.hrtime.bigint() / 1000n);

/**
 * 连 CDP。用 `ws` 包而不是 Node 自带的 WebSocket(undici),实测过两条:
 * - 自带的**能**带 `Origin`(非标准的 `{ headers }` 初始化参数),握手没问题;
 * - 但它总是协商 permessage-deflate,且对解压后的单条消息有固定上限、改不了 ——
 *   `Profiler.stop` 的回应一大(几个端点之后就会)连接直接断:"Max decompressed message size
 *   exceeded"。`ws` 能关掉压缩、自己定上限。
 */
export async function connectCdp(url) {
  const ws = new WebSocket(url, {
    origin: INSPECTOR_ORIGIN,
    perMessageDeflate: false,
    maxPayload: CDP_MAX_MESSAGE_BYTES,
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`cannot connect to inspector ${url}`)), {
      once: true,
    });
  });
  let nextId = 0;
  const pending = new Map();
  // 连接断了还挂着的请求一律失败 —— 否则 `Profiler.stop` 的回应丢了就是永远等下去。
  let closed = null;
  const failAll = (reason) => {
    closed = reason;
    for (const w of pending.values()) w.reject(new Error(`${w.method}: ${reason}`));
    pending.clear();
  };
  ws.addEventListener("close", (ev) => failAll(`inspector closed (${ev.code} ${ev.reason})`));
  ws.addEventListener("error", (ev) =>
    failAll(`inspector connection error: ${ev.message ?? ev.error?.message ?? "unknown"}`),
  );
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    const waiter = msg.id != null ? pending.get(msg.id) : undefined;
    if (!waiter) return; // 事件(Runtime.consoleAPICalled 之类)一概不要
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(msg.error)}`));
    else waiter.resolve(msg.result);
  });
  return {
    send(method, params = {}) {
      if (closed) return Promise.reject(new Error(`${method}: ${closed}`));
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: no reply from inspector after ${CDP_TIMEOUT_MS}ms`));
        }, CDP_TIMEOUT_MS);
        const settle = (fn) => (value) => {
          clearTimeout(timer);
          fn(value);
        };
        pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
      });
    },
    close: () => ws.close(),
  };
}

async function fire(url, init) {
  const t0 = nowUs();
  const res = await fetch(url, { ...init, redirect: "manual" });
  const bytes = (await res.arrayBuffer()).byteLength;
  return { startUs: t0, wallMs: (nowUs() - t0) / 1000, status: res.status, bytes };
}

/**
 * 对一个端点:预热 → 开采样 → 顺序发 reps 发 → 停采样。返回原始 profile 与每发的时间窗。
 * 一个端点一份 profile(而不是每发一份):start/stop 的开销不进窗口,raw 文件也好翻。
 */
export async function profileEndpoint(cdp, { url, init }, { reps, warmup }) {
  for (let i = 0; i < warmup; i++) await fire(url, init);
  const beforeStartUs = nowUs();
  await cdp.send("Profiler.start");
  const requests = [];
  for (let i = 0; i < reps; i++) requests.push(await fire(url, init));
  const stopUs = nowUs();
  const { profile } = await cdp.send("Profiler.stop");
  return { profile, requests, beforeStartUs, stopUs };
}

/**
 * 不开采样再发 reps 发,按内核账(见 worker.mjs 的 cpuNs)算每发的 CPU。是采样数字的交叉校验:
 * 它**多算**本地 D1(SQLite 跑在同一个 workerd 里,线上在 D1 那边)与运行时的 C++ 部分,
 * 但不受采样稀疏的影响。读不到 /proc → null。
 */
export async function measureProcessCpu({ url, init }, reps, cpuNs) {
  const before = cpuNs();
  if (before === null) return null;
  for (let i = 0; i < reps; i++) await fire(url, init);
  return (cpuNs() - before) / 1e6 / reps;
}

/** 冷启动:worker 刚起、还没接过请求时发第一发。 */
export async function profileFirstRequest(cdp, { url, init }) {
  const beforeStartUs = nowUs();
  await cdp.send("Profiler.start");
  const request = await fire(url, init);
  const stopUs = nowUs();
  const { profile } = await cdp.send("Profiler.stop");
  return { profile, requests: [request], beforeStartUs, stopUs };
}

/**
 * 把 profile 的每个采样按时间落到「第几发请求」上,并按归属累加自耗时。
 *
 * - 自耗时取 `timeDeltas`,**不是**「窗口 / 采样数」:两发之间 isolate 是闲的,平均会把闲时
 *   摊到每一帧上。`timeDeltas[i]` 是采样 i 之前流逝的微秒,记给采样 i —— 标准读法。
 * - 第 i 发的窗口是 [第 i 发开始, 第 i+1 发开始):响应发出之后的 `waitUntil` 收尾也算它的,
 *   线上计费也是这么算的。最后一发到 stop 为止。
 * - 稀疏样本(间隔远超设定)也照记,但单独统计占比(coarseShare),好让报表标出来。
 * - 这要求 profile 的时间戳与本机 `process.hrtime` 是同一个单调时钟(Linux 上 V8 与 libuv 都用
 *   CLOCK_MONOTONIC,实测对得上)。对不上就不拆分,只给总数 —— 宁可少一列,不给错的数。
 */
export function attribute(run, samplingUs) {
  const { profile, requests, beforeStartUs, stopUs } = run;
  const coarseAboveUs = samplingUs * COARSE_SAMPLE_FACTOR;
  let coarseUs = 0;
  const aligned =
    profile.startTime >= beforeStartUs - CLOCK_SKEW_TOLERANCE_US &&
    profile.startTime <= stopUs + CLOCK_SKEW_TOLERANCE_US;
  const starts = requests.map((r) => r.startUs);
  const perRequestUs = requests.map(() => 0);
  const byGroup = new Map();
  const byModule = new Map();
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const owners = new Map();
  let programUs = 0;
  let outsideUs = 0;
  let t = profile.startTime;
  let slot = -1;

  profile.samples.forEach((nodeId, i) => {
    const dt = profile.timeDeltas[i] ?? 0;
    t += dt;
    const frame = nodes.get(nodeId)?.callFrame;
    if (!frame) return;
    if (frame.functionName === "(program)") programUs += dt;
    if (NON_CPU_FRAMES.has(frame.functionName)) return;
    if (!owners.has(nodeId)) owners.set(nodeId, ownerOf(frame));
    const owner = owners.get(nodeId);
    byGroup.set(owner.group, (byGroup.get(owner.group) ?? 0) + dt);
    if (dt > coarseAboveUs) coarseUs += dt;
    const mkey = `${owner.group}\u0000${owner.module}`;
    byModule.set(mkey, (byModule.get(mkey) ?? 0) + dt);
    if (!aligned) return;
    while (slot + 1 < starts.length && t >= starts[slot + 1]) slot++;
    if (slot < 0) {
      outsideUs += dt;
      return;
    }
    perRequestUs[slot] += dt;
  });

  const totalUs = [...byGroup.values()].reduce((a, b) => a + b, 0);
  const n = requests.length;
  const perReqMs = (us) => us / 1000 / n;
  return {
    aligned,
    totalCpuMs: totalUs / 1000,
    meanCpuMs: perReqMs(totalUs),
    perRequestCpuMs: aligned ? perRequestUs.map((us) => us / 1000) : null,
    gcMs: perReqMs(byGroup.get("GC") ?? 0),
    programMs: perReqMs(programUs),
    outsideMs: outsideUs / 1000,
    // 计入 CPU 的时间里,来自稀疏样本的占比。高 → mean 仍可用,逐请求的 p50 / max 不可信。
    coarseShare: totalUs ? coarseUs / totalUs : 0,
    samples: profile.samples.length,
    owners: [...byGroup]
      .map(([group, us]) => ({ group, ms: perReqMs(us) }))
      .sort((a, b) => b.ms - a.ms),
    topModules: [...byModule]
      .map(([k, us]) => {
        const [group, module] = k.split("\u0000");
        return { group, module, ms: perReqMs(us) };
      })
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 25),
  };
}
