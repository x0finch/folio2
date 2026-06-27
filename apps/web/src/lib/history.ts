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
