const DAY_MS = 86_400_000;

export type HistoryRange = "7d" | "30d" | "1y" | "all";

const RANGE_DAYS: Record<Exclude<HistoryRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "1y": 365,
};

/** range → since(epoch ms);"all" → undefined(不裁窗口)。nowMs 由调用方传入(可测/可控)。 */
export function rangeSince(range: HistoryRange, nowMs: number): number | undefined {
  return range === "all" ? undefined : nowMs - RANGE_DAYS[range] * DAY_MS;
}

/** 长窗(1年/全部)走 SQL min-max;短窗(7/30 天)照旧发原始点(FOL-46)。 */
export const isLongHistoryRange = (range: HistoryRange): boolean =>
  range === "1y" || range === "all";

/** 是否走 min-max 降采样:显式长窗,或省略 range 时窗口跨度 ≥ 1 年 / 不限(since 缺省)。 */
export function shouldSampleHistory(opts: {
  range?: HistoryRange;
  since?: number;
  nowMs?: number;
}): boolean {
  if (opts.range != null) return isLongHistoryRange(opts.range);
  if (opts.since == null) return true;
  const now = opts.nowMs ?? Date.now();
  return now - opts.since >= RANGE_DAYS["1y"] * DAY_MS;
}
