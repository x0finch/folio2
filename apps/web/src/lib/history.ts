// 纯逻辑(无 server-only import → 可单测)。
// 把"每账户、各自时刻"的快照总额拼成【组合净值随时间】的序列。
//
// 关键:某时刻 T 的组合净值 = Σ 各账户在 T 之前最近一次快照的 totalUsd(账户的 takenAt 并不对齐)。
// 阶梯式重建:按 takenAt 升序遍历,维护 accountId→最近 totalUsd 的累积表,逐事件产出
// { t, total = Σ 当前表 }。同一 takenAt 的多账户事件先全部并入、只产一个点(避免同刻多点)。

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
): HistoryPoint[] {
  if (series.length <= 1) return [...series];
  const span = series[series.length - 1].t - series[0].t; // 约定升序(buildPortfolioHistory 已排序)
  const bucket =
    BUCKET_LADDER.find((b) => span / b <= maxPoints) ?? BUCKET_LADDER[BUCKET_LADDER.length - 1];
  const byBucket = new Map<number, HistoryPoint>();
  for (const p of series) byBucket.set(Math.floor(p.t / bucket), p); // 升序 → 后写覆盖 = 该桶最后一个
  return [...byBucket.values()].sort((a, b) => a.t - b.t);
}

export function buildPortfolioHistory(rows: SnapshotTotalRow[]): HistoryPoint[] {
  // 入参约定升序;为稳健起见自排一次(不依赖调用方排序)。
  const sorted = [...rows].sort((a, b) => a.takenAt - b.takenAt);
  const latestByAccount = new Map<string, number>();
  const points: HistoryPoint[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    latestByAccount.set(row.accountId, row.totalUsd);
    // 仅在该 takenAt 的最后一条之后产点 → 同刻多账户合并为一个点。
    const isLastAtThisTime = i + 1 === sorted.length || sorted[i + 1].takenAt !== row.takenAt;
    if (!isLastAtThisTime) continue;
    let total = 0;
    for (const v of latestByAccount.values()) total += v;
    points.push({ t: row.takenAt, total });
  }

  return points;
}
