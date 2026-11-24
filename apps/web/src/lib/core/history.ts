// Chart algorithms run in the browser: the Worker has 10ms CPU per request and the raw points are
// small, so the server only reads and ships them.

export interface SnapshotTotalRow {
  accountId: string;
  takenAt: number;
  totalUsd: number;
}

export interface HistoryPoint {
  t: number; // epoch ms
  total: number; // portfolio net worth at t
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Finest first. The snapshot writer collapses same-hour rows using the finest step, so change
// `HOUR_MS` here together with it.
const BUCKET_LADDER = [
  HOUR_MS,
  2 * HOUR_MS,
  4 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  7 * DAY_MS,
];
const TARGET_MAX_POINTS = 40;

export type { HistoryRange } from "./history-range";
export { rangeSince } from "./history-range";

// Picks the finest bucket that fits maxPoints and keeps each bucket's last (closing) point, so
// bursts of manual syncs don't make the chart jitter. The last (live) point always survives.
export function downsampleSeries(
  series: readonly HistoryPoint[],
  maxPoints = TARGET_MAX_POINTS,
  minBucket = 0,
): HistoryPoint[] {
  if (series.length <= 1) return [...series];
  const span = series[series.length - 1].t - series[0].t; // series is ascending
  const bucket =
    BUCKET_LADDER.find((b) => b >= minBucket && span / b <= maxPoints) ??
    BUCKET_LADDER[BUCKET_LADDER.length - 1];
  const byBucket = new Map<number, HistoryPoint>();
  for (const p of series) byBucket.set(Math.floor(p.t / bucket), p); // ascending → last wins
  return [...byBucket.values()].sort((a, b) => a.t - b.t);
}

// Keeps each bucket's min and max (earlier on ties) so spikes and crashes survive, unlike the
// closing-point `downsampleSeries`. First and last points are always kept: per-series sampled data is
// later summed across accounts by takenAt, and a missing window start would carve a fake dip.
export function minMaxDownsampleHistory(
  points: readonly HistoryPoint[],
  buckets = TARGET_MAX_POINTS,
): HistoryPoint[] {
  if (points.length <= 1) return [...points];
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const tMin = first.t;
  const tMax = last.t;
  if (tMax === tMin) return [first];

  const byBucket = new Map<number, { min: HistoryPoint; max: HistoryPoint }>();
  for (const p of sorted) {
    const bucket = Math.min(
      Math.floor(((p.t - tMin) * (buckets - 1)) / (tMax - tMin)),
      buckets - 1,
    );
    const cur = byBucket.get(bucket);
    if (!cur) {
      byBucket.set(bucket, { min: p, max: p });
      continue;
    }
    if (p.total < cur.min.total) cur.min = p;
    if (p.total > cur.max.total) cur.max = p;
  }

  const out: HistoryPoint[] = [];
  for (const { min, max } of byBucket.values()) {
    out.push(min);
    if (max !== min) out.push(max);
  }
  if (!out.some((p) => p.t === first.t)) out.push(first);
  if (!out.some((p) => p.t === last.t)) out.push(last);
  return out.sort((a, b) => a.t - b.t);
}

// Never finer than a day: the Insights chart labels its X axis by day, so intraday points would
// print the same date repeatedly.
export const toDailySeries = (series: readonly HistoryPoint[]): HistoryPoint[] =>
  downsampleSeries(series, TARGET_MAX_POINTS, DAY_MS);

// After archiving, an account stops contributing (earlier points stay). Without this, the step
// rebuild would carry its frozen last value forward to a live point that excludes it, so the
// curve would drop at the right edge. `<=`: excluded from the archive instant on.
export type ArchivedAt = ReadonlyMap<string, number>;

// Net worth at T = Σ each account's latest snapshot at or before T (takenAts don't align). Events
// sharing a takenAt emit one point.
export function buildPortfolioHistory(
  rows: readonly SnapshotTotalRow[],
  archivedAt: ArchivedAt = new Map(),
): HistoryPoint[] {
  const sorted = [...rows].sort((a, b) => a.takenAt - b.takenAt);
  const latestByAccount = new Map<string, number>();
  const points: HistoryPoint[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    latestByAccount.set(row.accountId, row.totalUsd);
    const isLastAtThisTime = i + 1 === sorted.length || sorted[i + 1].takenAt !== row.takenAt;
    if (!isLastAtThisTime) continue;
    let total = 0;
    for (const [accountId, v] of latestByAccount) {
      const archived = archivedAt.get(accountId);
      if (archived != null && archived <= row.takenAt) continue;
      total += v;
    }
    points.push({ t: row.takenAt, total });
  }

  return points;
}

// Archive map as pairs, not a Map: it goes through JSON.
export interface PortfolioHistoryRaw {
  rows: SnapshotTotalRow[];
  archivedAt: [accountId: string, at: number][];
  liveAccountIds: string[];
  sampled?: boolean;
}

export interface AccountTotals {
  accountTotals: readonly { account: { id: string }; totalUsd: number }[];
}

// The last point is replaced by live net worth so it matches the hero number on the same screen.
// Takes the per-account table, not the overview total: the curve is never narrowed by a tab pin but
// the overview total may be, so a missing account means "wrong scope" and the frozen point stays.
// Sampled (long-window) rows are real portfolio values at bucket extremes, then min-max downsampled.
export function toPortfolioCurve(
  raw: PortfolioHistoryRaw,
  overview: AccountTotals,
): HistoryPoint[] {
  const rebuilt = buildPortfolioHistory(raw.rows, new Map(raw.archivedAt));
  const series = raw.sampled ? minMaxDownsampleHistory(rebuilt) : rebuilt;
  if (series.length === 0) return series;
  const byAccount = new Map(overview.accountTotals.map((a) => [a.account.id, a.totalUsd]));
  let live = 0;
  for (const id of raw.liveAccountIds) {
    const total = byAccount.get(id);
    if (total == null) return series; // overview has a different scope; keep the frozen point
    live += total;
  }
  series[series.length - 1] = { t: series[series.length - 1].t, total: live };
  return series;
}

// The window is already applied by the endpoint. `live` exists only for manual accounts (ledger
// priced now); snapshot accounts and archived accounts keep their frozen last point.
export interface AccountHistoryRaw {
  rows: { takenAt: number; totalUsd: number }[];
  live: HistoryPoint | null;
  sampled?: boolean;
}

export function buildAccountValueHistory(
  snapshots: readonly { takenAt: number; totalUsd: number }[],
  live?: HistoryPoint | null,
  opts?: { sampled?: boolean },
): HistoryPoint[] {
  const rows: SnapshotTotalRow[] = snapshots.map((s) => ({
    accountId: "_",
    takenAt: s.takenAt,
    totalUsd: s.totalUsd,
  }));
  const base = buildPortfolioHistory(rows);
  // Long windows are pre-capped per bucket server-side; min-max downsample here.
  const series = opts?.sampled ? minMaxDownsampleHistory(base) : downsampleSeries(base);
  if (live == null || series.length === 0) return series;
  const last = series[series.length - 1];
  if (last.t >= live.t) series[series.length - 1] = { t: last.t, total: live.total };
  else series.push(live);
  return series;
}
