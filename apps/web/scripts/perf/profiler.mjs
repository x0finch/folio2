// V8 sampling profiler, driven from outside via workerd's inspector (CDP).
//
// Not `performance.now()` inside the worker: workerd's clock doesn't advance during synchronous compute (a timing side-channel defence), so `withServerFnTiming`'s durationMs sees I/O waits but not CPU. The sampling profiler ticks on real time in V8.
import { availableParallelism, loadavg } from "node:os";
import { WebSocket } from "ws";
import { HOST } from "./constants.mjs";
import { NON_CPU_FRAMES, ownerOf } from "./owners.mjs";

/** workerd's inspector proxy rejects upgrades without an `Origin` header (HTTP 400 "Expected Origin header"). */
const INSPECTOR_ORIGIN = "http://127.0.0.1";
/** Cap on waiting for one CDP command's reply; `Profiler.stop` replies are several MB but normally return within a second. */
const CDP_TIMEOUT_MS = 60_000;
/** Cap on one CDP message; a 30-request profile is ~4 MB, so leave headroom. */
const CDP_MAX_MESSAGE_BYTES = 512 * 1024 * 1024;
/** Allowed skew (microseconds) between the profile start and the local monotonic clock; beyond it the two aren't the same clock (see attribute). */
const CLOCK_SKEW_TOLERANCE_US = 50_000;
/** A sample whose interval exceeds the configured one by this factor is "sparse": when the isolate idles sampling stops, and the first sample after resuming carries the whole gap on that frame. Totals stay roughly right but which request gets it is luck; cheap endpoints have a high share (see coarseShare). */
export const COARSE_SAMPLE_FACTOR = 10;

const nowUs = () => Number(process.hrtime.bigint() / 1000n);

/** Connects over CDP using the `ws` package, not Node's built-in WebSocket (undici): the built-in sends `Origin` fine but always negotiates permessage-deflate with a fixed, unchangeable decompressed-message cap, so a large `Profiler.stop` reply drops the connection ("Max decompressed message size exceeded"). `ws` can disable compression and set its own cap. */
async function connectCdp(url) {
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
  // Fail every request still pending when the connection drops, or a lost `Profiler.stop` reply would hang forever.
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
    if (!waiter) return; // ignore events (Runtime.consoleAPICalled etc.)
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

/** When the machine is busy, sampled CPU runs high (stolen slices land on the running frame). A 1-minute load above this fraction of cores is warned about and written into the summary so runs can be compared. */
const BUSY_LOAD_RATIO = 0.75;

export function hostLoad() {
  const cpus = availableParallelism();
  const [load1] = loadavg();
  return {
    cpus,
    load1: +load1.toFixed(2),
    busy: load1 > cpus * BUSY_LOAD_RATIO,
    node: process.version,
  };
}

/** Connects to the inspector, starts the sampler, runs fn(cdp), and always closes it. */
export async function withCdp({ inspectorPort, samplingUs }, fn) {
  const cdp = await connectCdp(`ws://${HOST}:${inspectorPort}/ws`);
  try {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: samplingUs });
    return await fn(cdp);
  } finally {
    await cdp.send("Profiler.disable").catch(() => {});
    cdp.close();
  }
}

async function fire(url, init) {
  const t0 = nowUs();
  const res = await fetch(url, { ...init, redirect: "manual" });
  const bytes = (await res.arrayBuffer()).byteLength;
  return { startUs: t0, wallMs: (nowUs() - t0) / 1000, status: res.status, bytes };
}

/** Per endpoint: warm up, start sampling, send `reps` requests sequentially, stop. Returns the raw profile and each request's time window. One profile per endpoint (not per request) keeps start/stop cost out of the windows. */
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

/** Sends `reps` more requests without sampling and computes per-request CPU from the kernel's accounting (see worker.mjs cpuNs): a cross-check on the sampled numbers. It over-counts local D1 (SQLite runs inside workerd; online it's on the D1 side) and the runtime's C++ part, but is immune to sparse sampling. null if /proc is unreadable. */
export async function measureProcessCpu({ url, init }, reps, cpuNs) {
  const before = cpuNs();
  if (before === null) return null;
  for (let i = 0; i < reps; i++) await fire(url, init);
  return (cpuNs() - before) / 1e6 / reps;
}

/** Profiles one window (perf:cpu:jobs): start sampling, `trigger()` (fire one cron, wait for the reply), `settle()` (wait for follow-up invocations such as queue consumers), stop. Unlike profileEndpoint, one trigger can be several invocations (one cron + N queue batches); `settle()` reports their start times (`invocations: [{ startUs, ... }]`) to form the request table attribute splits. `cpuNs` is read at both ends of the window, the same span as sampling, so it includes the sampler's own overhead. */
export async function profileWindow(cdp, { trigger, settle, cpuNs }) {
  const beforeStartUs = nowUs();
  await cdp.send("Profiler.start");
  const cpuBefore = cpuNs();
  const startUs = nowUs();
  const triggered = await trigger();
  const later = await settle(triggered);
  const cpuAfter = cpuNs();
  const stopUs = nowUs();
  const { profile } = await cdp.send("Profiler.stop");
  return {
    profile,
    beforeStartUs,
    stopUs,
    triggered,
    // Slot 0 is the triggered invocation itself (from the trigger); the rest are the follow-ups settle reported.
    requests: [{ startUs, ...triggered }, ...later.invocations],
    settled: later,
    procCpuMs: cpuBefore === null || cpuAfter === null ? null : (cpuAfter - cpuBefore) / 1e6,
  };
}

/** Cold start: send the first request right after the worker starts, before it has served anything. */
export async function profileFirstRequest(cdp, { url, init }) {
  const beforeStartUs = nowUs();
  await cdp.send("Profiler.start");
  const request = await fire(url, init);
  const stopUs = nowUs();
  const { profile } = await cdp.send("Profiler.stop");
  return { profile, requests: [request], beforeStartUs, stopUs };
}

/** Assigns each profile sample to a request by time and accumulates self time per owner. Self time uses `timeDeltas` (microseconds elapsed before sample i, credited to sample i), not window / sample count, which would spread idle time over frames. Request i's window is [start of i, start of i+1), so post-response `waitUntil` work counts for it, as billing does; the last runs to stop. Sparse samples are counted but their share is tracked (coarseShare). Requires the profile timestamps and `process.hrtime` to share a monotonic clock (true on Linux: V8 and libuv both use CLOCK_MONOTONIC); otherwise no split, only totals. `maxSampleUs` (perf:cpu:jobs): one sample counts at most this much, the excess goes to `gapMs` and isn't CPU: a cron mostly waits (gate, upstream, D1) with the sampler stopped, and the first sample after resuming carries the gap (one sweep: 21s of a 27s window against 6s of kernel accounting). Requests only have gaps between requests (see coarseShare), so perf:cpu omits it. */
export function attribute(run, samplingUs, { maxSampleUs } = {}) {
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
  let gapUs = 0;
  let t = profile.startTime;
  let slot = -1;

  profile.samples.forEach((nodeId, i) => {
    const raw = profile.timeDeltas[i] ?? 0;
    t += raw;
    const frame = nodes.get(nodeId)?.callFrame;
    if (!frame) return;
    const dt = maxSampleUs ? Math.min(raw, maxSampleUs) : raw;
    if (!NON_CPU_FRAMES.has(frame.functionName)) gapUs += raw - dt;
    if (frame.functionName === "(program)") programUs += dt;
    if (NON_CPU_FRAMES.has(frame.functionName)) return;
    if (!owners.has(nodeId)) owners.set(nodeId, ownerOf(frame));
    const owner = owners.get(nodeId);
    byGroup.set(owner.group, (byGroup.get(owner.group) ?? 0) + dt);
    if (raw > coarseAboveUs) coarseUs += dt;
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
    gapMs: gapUs / 1000,
    // Share of counted CPU from sparse samples. High: the mean is still usable but per-request p50 / max aren't.
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
