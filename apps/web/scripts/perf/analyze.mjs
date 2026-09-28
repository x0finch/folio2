// perf:cpu:analyze —— 把 perf:cpu:jobs 写下的 profile 拆成「逐调用 kind、逐函数」的 top-N。
//
//   pnpm --filter @folio/web perf:cpu:analyze <run-dir> [--top 25] [--kind sync-account] [--json]
//
// owners 列只说到包(「Effect 325 ms」),看不出是 Effect 里的哪件事(Schema 解码?Layer 构造?
// fiber 调度?)。这里按函数(名字 + 源模块 + 行号)累加两种时间,都按**每次调用**平均:
// - self:采样落在这一帧本身;
// - inclusive:采样的调用栈里有这一帧(一个样本对同一个函数只记一次,递归不重复算)。
// 源模块用 owners.mjs 的 region 映射(`//#region <源路径>`)。行号只对产出 profile 的那次构建有效,
// 所以 perf:cpu:jobs 把那次的 region 表存进输出目录(`regions.json`),这里优先用它。
//
// 时间窗与样本封顶和 jobs.mjs 同一个规则:第 i 格 = [第 i 次调用开始, 第 i+1 次开始),单个样本最多
// 记 `maxSampleUs`(`<scenario>-<tag>.slots.json` 里带着)。`:first` 那次单列(冷数据),默认跳过。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadRegions, NON_CPU_FRAMES, ownerOf } from "./owners.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    top: { type: "string", default: "25" },
    kind: { type: "string" },
    "with-first": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    // 自顶向下的调用树(按 kind 聚合),只画 inclusive ≥ `--min-ms` 的节点。`--collapse` 的帧
    // (默认 Effect 的 fiber 运行时 / 调度器)不画,子节点挂到最近一个画出来的祖先上 —— 否则树
    // 里一半是 runLoop / evaluateEffect,看不出是谁的活。
    tree: { type: "boolean", default: false },
    "min-ms": { type: "string", default: "0.5" },
    collapse: {
      type: "string",
      default:
        "effect/dist/esm/(internal/(fiberRuntime|core|core-effect|runtime|managedRuntime|tracer|fiberRefs|layer|circular/.*|stream|channel.*|sink|take|effect/circular|context|option|either)|Scheduler|Utils|Function|Effect|Stream|Layer|Option|Either|Pipeable|Micro)\\.js",
    },
  },
});
const dir = positionals[0];
if (!dir) {
  console.error("usage: perf:cpu:analyze <run-dir> [--top N] [--kind K] [--with-first] [--json]");
  process.exit(2);
}
const TOP = Number(values.top);
// profile 的行号只对产出它的那次构建有效:输出目录里有 region 表就用它,没有(老的输出)才读当前 `dist/`。
if (existsSync(join(dir, "regions.json")))
  loadRegions(JSON.parse(readFileSync(join(dir, "regions.json"), "utf8")));
else console.error("no regions.json in the run dir — mapping frames against the current dist/");
const COLLAPSE = new RegExp(values.collapse);
const MIN_US = Number(values["min-ms"]) * 1000;
function newTreeNode(name) {
  return { name, us: 0, children: new Map() };
}

/** kind(`<scenario>:<kind>`)→ { n, totalUs, self: Map, incl: Map } */
const byKind = new Map();
const bucket = (key) => {
  let b = byKind.get(key);
  if (!b) {
    b = { n: 0, totalUs: 0, self: new Map(), incl: new Map(), tree: newTreeNode("(root)") };
    byKind.set(key, b);
  }
  return b;
};

function frameKey(frame) {
  const o = ownerOf(frame);
  const mod = o.module.replace(/^.*node_modules\/\.pnpm\/[^/]+\/node_modules\//, "");
  return `${frame.functionName || "(anon)"}  ${mod}:${frame.lineNumber + 1}`;
}

for (const file of readdirSync(dir).filter((f) => f.endsWith(".slots.json"))) {
  const meta = JSON.parse(readFileSync(join(dir, file), "utf8"));
  if (!values["with-first"] && file.includes("-first.")) continue;
  const profile = JSON.parse(
    readFileSync(join(dir, file.replace(".slots.json", ".cpuprofile")), "utf8"),
  );
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const keyOf = new Map();
  const key = (id) => {
    if (!keyOf.has(id)) keyOf.set(id, frameKey(nodes.get(id).callFrame));
    return keyOf.get(id);
  };
  const starts = meta.slots.map((s) => s.startUs);
  const slotBuckets = meta.slots.map((s) => bucket(`${meta.scenario}:${s.kind}`));
  for (const b of new Set(slotBuckets)) b.n += slotBuckets.filter((x) => x === b).length;
  let t = profile.startTime;
  let slot = -1;
  profile.samples.forEach((id, i) => {
    const raw = profile.timeDeltas[i] ?? 0;
    t += raw;
    const frame = nodes.get(id)?.callFrame;
    if (!frame || NON_CPU_FRAMES.has(frame.functionName)) return;
    while (slot + 1 < starts.length && t >= starts[slot + 1]) slot++;
    if (slot < 0) return;
    const dt = Math.min(raw, meta.maxSampleUs);
    const b = slotBuckets[slot];
    b.totalUs += dt;
    const k = key(id);
    b.self.set(k, (b.self.get(k) ?? 0) + dt);
    // 调用树:从根往下,跳过被 collapse 的帧。
    const stack = [];
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const f = nodes.get(cur).callFrame;
      if (NON_CPU_FRAMES.has(f.functionName)) continue;
      const ck = key(cur);
      if (cur !== id && COLLAPSE.test(ck)) continue;
      stack.push(ck);
    }
    let tn = b.tree;
    tn.us += dt;
    for (let j = stack.length - 1; j >= 0; j--) {
      let child = tn.children.get(stack[j]);
      if (!child) {
        child = newTreeNode(stack[j]);
        tn.children.set(stack[j], child);
      }
      child.us += dt;
      tn = child;
    }
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const f = nodes.get(cur).callFrame;
      if (NON_CPU_FRAMES.has(f.functionName)) continue;
      const ck = key(cur);
      if (seen.has(ck)) continue;
      seen.add(ck);
      b.incl.set(ck, (b.incl.get(ck) ?? 0) + dt);
    }
  });
}

const top = (m, n) =>
  [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([k, us]) => ({ fn: k, ms: +(us / 1000 / n).toFixed(2) }));

const out = [...byKind]
  .filter(([k]) => !values.kind || k.endsWith(`:${values.kind}`))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, b]) => ({
    kind: k,
    invocations: b.n,
    meanMs: +(b.totalUs / 1000 / b.n).toFixed(2),
    self: top(b.self, b.n),
    inclusive: top(b.incl, b.n),
    tree: b.tree,
  }));
for (const k of out) if (!values.tree) delete k.tree;

function printTree(node, n, depth) {
  const kids = [...node.children.values()].sort((a, b) => b.us - a.us);
  for (const k of kids) {
    if (k.us / n < MIN_US) continue;
    console.log(`${(k.us / 1000 / n).toFixed(2).padStart(7)}  ${"  ".repeat(depth)}${k.name}`);
    printTree(k, n, depth + 1);
  }
}

if (values.tree)
  for (const k of out) {
    console.log(`\n=== ${k.kind}  (n=${k.invocations}, mean ${k.meanMs} ms/invocation)`);
    printTree(k.tree, k.invocations, 0);
  }
else if (values.json) console.log(JSON.stringify(out, null, 2));
else
  for (const k of out) {
    console.log(`\n=== ${k.kind}  (n=${k.invocations}, mean ${k.meanMs} ms/invocation)`);
    console.log("  -- self (ms/invocation)");
    for (const r of k.self) console.log(`  ${r.ms.toFixed(2).padStart(7)}  ${r.fn}`);
    console.log("  -- inclusive (ms/invocation)");
    for (const r of k.inclusive) console.log(`  ${r.ms.toFixed(2).padStart(7)}  ${r.fn}`);
  }
