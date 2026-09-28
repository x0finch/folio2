// 结果 → 一行一端点的表(stdout)。JSON 明细由 cpu.mjs 直接写盘,这里只管给人看的那一份。

/** 报表里每个端点列出前几名归属。 */
const TOP_OWNERS = 4;
/** 小于它的归属不列(噪声)。 */
const OWNER_FLOOR_MS = 0.05;
/** 稀疏样本占 CPU 的比例超过它,就在端点名后标 `*`(p50 / max 只是粗估)。 */
const COARSE_FLAG_SHARE = 0.25;

export function quantile(xs, q) {
  if (!xs?.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

const ms = (x) => (x == null ? "—" : x.toFixed(1));

/** 把「Effect 9.9 · TanStack Start 3.1 · …」压成一格。 */
function ownerCell(owners) {
  return owners
    .filter((o) => o.ms >= OWNER_FLOOR_MS)
    .slice(0, TOP_OWNERS)
    .map((o) => `${o.group} ${o.ms.toFixed(1)}`)
    .join(" · ");
}

/**
 * rows: [{ key, status, expect, meanCpuMs, p50CpuMs, maxCpuMs, procCpuMs?, wallP50Ms, owners }]
 * 超预算的行以 `!` 起头;状态码对不上的在 status 格后面标 `≠<期望>`。
 */
export function formatTable(rows, { budgetMs, title }) {
  const header = [
    "",
    "endpoint",
    "status",
    "mean",
    "p50",
    "max",
    "proc",
    "wall p50",
    "owners (mean ms/req)",
  ];
  const body = rows.map((r) => [
    r.meanCpuMs > budgetMs ? "!" : " ",
    r.coarseShare > COARSE_FLAG_SHARE ? `${r.key}*` : r.key,
    r.status === r.expect ? String(r.status) : `${r.status}≠${r.expect}`,
    ms(r.meanCpuMs),
    ms(r.p50CpuMs),
    ms(r.maxCpuMs),
    ms(r.procCpuMs),
    ms(r.wallP50Ms),
    ownerCell(r.owners),
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...body.map((row) => row[c].length)));
  const numeric = new Set([3, 4, 5, 6, 7]);
  const line = (row) =>
    row
      .map((cell, c) => (numeric.has(c) ? cell.padStart(widths[c]) : cell.padEnd(widths[c])))
      .join("  ")
      .trimEnd();
  const over = rows.filter((r) => r.meanCpuMs > budgetMs).length;
  const coarse = rows.some((r) => r.coarseShare > COARSE_FLAG_SHARE);
  return [
    title,
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...body.map(line),
    "",
    "mean/p50/max: V8 samples (JS + GC). proc: workerd on-CPU per request from the kernel (incl. local D1).",
    `budget ${budgetMs} ms → ${over}/${rows.length} over (marked !).`,
    ...(coarse
      ? [
          "* >25% of sampled CPU came from samples >10x the interval apart (sampler starved, often a busy host):",
          "  per-request p50/max are rough — cross-check mean against proc.",
        ]
      : []),
  ].join("\n");
}

/**
 * perf:cpu:jobs 的表:一行一个定时任务(或它的 `:first` / `:queue` / `:window`)。
 * rows: [{ key, n, status, ok, result, meanCpuMs, p50CpuMs, maxCpuMs, procCpuMs, wallP50Ms, fetches, owners }]
 * mean/p50/max 是**每次调用**的 CPU(同一行的 n 次之间比);超预算以 `!` 起头,没干成的状态格标 `✗`。
 */
export function formatJobsTable(rows, { budgetMs, title }) {
  const header = [
    "",
    "invocation",
    "n",
    "status",
    "mean",
    "p50",
    "max",
    "proc",
    "wall p50",
    "fetches",
    "result",
    "owners (mean ms/invocation)",
  ];
  const body = rows.map((r) => [
    r.meanCpuMs > budgetMs ? "!" : " ",
    r.coarseShare > COARSE_FLAG_SHARE ? `${r.key}*` : r.key,
    String(r.n),
    r.ok ? r.status : `${r.status} ✗`,
    ms(r.meanCpuMs),
    ms(r.p50CpuMs),
    ms(r.maxCpuMs),
    ms(r.procCpuMs),
    ms(r.wallP50Ms),
    r.fetches == null ? "—" : r.fetches.toFixed(0),
    r.result,
    ownerCell(r.owners),
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...body.map((row) => row[c].length)));
  const numeric = new Set([2, 4, 5, 6, 7, 8, 9]);
  const line = (row) =>
    row
      .map((cell, c) => (numeric.has(c) ? cell.padStart(widths[c]) : cell.padEnd(widths[c])))
      .join("  ")
      .trimEnd();
  const over = rows.filter((r) => r.meanCpuMs > budgetMs).length;
  return [
    title,
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...body.map(line),
    "",
    "mean/p50/max: V8 samples (JS + GC) per invocation, across n invocations (fresh worker each).",
    "proc: workerd on-CPU for the same window from the kernel (incl. local D1 + sampler overhead).",
    "fetches: requests the fake upstream received during that invocation.",
    `budget ${budgetMs} ms → ${over}/${rows.length} over (marked !). Local CPU ≠ edge CPU: compare shapes and deltas.`,
  ].join("\n");
}
