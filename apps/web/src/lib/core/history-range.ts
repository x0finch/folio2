const DAY_MS = 86_400_000;

export type HistoryRange = "7d" | "30d" | "1y" | "all";

const RANGE_DAYS: Record<Exclude<HistoryRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "1y": 365,
};

/** Epoch ms; undefined for "all" (no window). */
export function rangeSince(range: HistoryRange, nowMs: number): number | undefined {
  return range === "all" ? undefined : nowMs - RANGE_DAYS[range] * DAY_MS;
}

const isLongHistoryRange = (range: HistoryRange): boolean => range === "1y" || range === "all";

function shouldSampleHistory(opts: {
  range?: HistoryRange;
  since?: number;
  nowMs?: number;
}): boolean {
  if (opts.range != null) return isLongHistoryRange(opts.range);
  if (opts.since == null) return true;
  const now = opts.nowMs ?? Date.now();
  return now - opts.since >= RANGE_DAYS["1y"] * DAY_MS;
}

// Beyond 7 days the chart reads daily rollups: hourly is 168 rows/account at 7d (affordable, and
// intraday moves matter), but 720 at 30d where the chart is drawn per day anyway.
const DAILY_HISTORY_MIN_DAYS = 7;

/**
 * `hourly`: raw snapshots (≤ 7d). `daily`: daily rollups (< 1y). `sampled`: rollups capped per
 * bucket in SQL, then min-max downsampled in the browser (1y / all).
 */
export type HistoryResolution = "hourly" | "daily" | "sampled";

export function historyResolution(opts: {
  range?: HistoryRange;
  since?: number;
  nowMs?: number;
}): HistoryResolution {
  if (shouldSampleHistory(opts)) return "sampled";
  const days =
    opts.range != null && opts.range !== "all"
      ? RANGE_DAYS[opts.range]
      : ((opts.nowMs ?? Date.now()) - (opts.since ?? 0)) / DAY_MS;
  return days > DAILY_HISTORY_MIN_DAYS ? "daily" : "hourly";
}
