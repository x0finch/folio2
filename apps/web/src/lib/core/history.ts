// 曲线的**采样**原语(纯逻辑,可单测)。两侧都在用:服务端重建完曲线后降采样,
// 首页 hero 与洞察页拿到序列后自己再采一次。从快照重建曲线那半只有服务端用,
// 住 lib/server/internal/history.ts。

// 一条账户快照的总额行(重建组合曲线的输入;manual 账户现算的序列也产这个形状)。
export interface SnapshotTotalRow {
  accountId: string;
  takenAt: number;
  totalUsd: number;
}

export interface HistoryPoint {
  t: number; // epoch ms
  total: number; // 该时刻组合净值
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// 桶粒度阶梯(升序):最细 1 小时、最粗 7 天。降采样时挑"能把点数压到 ≤ maxPoints 的最细桶"。
// **写侧按同一个钟点折叠**(#461,`SnapshotStore.write` 的 `collapseSameHour`),桶宽就是取的
// 这里的最细一档 —— 改动 `HOUR_MS` 这一档要连着那边一起看。
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

// 自适应降采样:按数据【实际跨度】选桶,每桶保留最后一个点(该桶收盘值),压掉"日内手动多次
// 同步"造成的密集簇,同时让粒度随数据量自适应 —— 约 1 天数据 → 小时级点,约 30 天 → 日级点。
// 快照是事件驱动的(每次同步一个点),直接画会随刷新频率抖动。末点(今日 live 覆写点)天然保留
// → 与主页总额一致。区间可切换的 Insights 视图应自行按 range 选粒度,不复用此处的自适应策略。
export function downsampleSeries(
  series: readonly HistoryPoint[],
  maxPoints = TARGET_MAX_POINTS,
  minBucket = 0,
): HistoryPoint[] {
  if (series.length <= 1) return [...series];
  const span = series[series.length - 1].t - series[0].t; // 约定升序(buildPortfolioHistory 已排序)
  const bucket =
    BUCKET_LADDER.find((b) => b >= minBucket && span / b <= maxPoints) ??
    BUCKET_LADDER[BUCKET_LADDER.length - 1];
  const byBucket = new Map<number, HistoryPoint>();
  for (const p of series) byBucket.set(Math.floor(p.t / bucket), p); // 升序 → 后写覆盖 = 该桶最后一个
  return [...byBucket.values()].sort((a, b) => a.t - b.t);
}

// Insights 的走势图专用:**粒度不细于一天**。
//
// 那张图的 X 轴只标到「日」,而上面的自适应策略是按跨度选桶的 —— 6 天数据落在 4 小时桶,
// 于是「同一天里同步了几次」就变成同一天的好几个点,X 轴连着印出 7 个 "Jul 28"。
// (自适应本身没错,主页 hero 那张小图不标 X 轴,细粒度正是它要的。)
export const toDailySeries = (series: readonly HistoryPoint[]): HistoryPoint[] =>
  downsampleSeries(series, TARGET_MAX_POINTS, DAY_MS);

// 单账户价值历史(A2 抽屉头部 chart):该账户快照 (takenAt, totalUsd) → 升序 HistoryPoint[]。
// 单账户即组合净值阶梯重建的退化情形(每 takenAt 一点),故复用 buildPortfolioHistory + 自适应降采样。
// since 裁窗口(仅保留 takenAt ≥ since 的快照);末点 = 最新快照冻结总额,与账户行/抽屉头
// account.totalUsd 同源(曲线当下点 ≡ 头部数值,无需 live 覆写 —— 那是主页 hero 专属)。
