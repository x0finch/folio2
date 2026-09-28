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

/** 长窗(1年/全部)服务端做 min-max 降采样(FOL-46);短窗发原料(7 天原始点、30 天日汇总,FOL-91)。 */
const isLongHistoryRange = (range: HistoryRange): boolean => range === "1y" || range === "all";

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

/**
 * 窗口超过这么多天,曲线改读**日汇总**(每账户每天一行,FOL-91),不再逐张读逐小时快照。
 *
 * 为什么是 7:7 天逐小时是每账户 168 行,读得起,而且那张图要的就是日内起伏;30 天逐小时是 720 行,
 * 而 30 天的图本来就按天画(Insights 走 `toDailySeries`、账户抽屉按跨度落到日桶),日内那些点
 * 读出来也是被降采样扔掉的。
 */
const DAILY_HISTORY_MIN_DAYS = 7;

/**
 * 一条曲线读哪一档原料:
 *   · `hourly`  —— 窗口内的原始快照(≤ 7 天)。
 *   · `daily`   —— 日汇总,不降采样(> 7 天、< 1 年)。
 *   · `sampled` —— 日汇总再做 min-max 降采样(1 年 / 全部,见 `shouldSampleHistory`)。
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
