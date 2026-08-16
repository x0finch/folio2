import { downsampleSeries, type HistoryPoint, type SnapshotTotalRow } from "../../core/history";

// 把「每账户、各自时刻」的快照总额拼成【组合净值随时间】的序列 —— 只有服务端做这件事。
//
// 关键:某时刻 T 的组合净值 = Σ 各账户在 T 之前最近一次快照的 totalUsd(账户的 takenAt 并不对齐)。
// 阶梯式重建:按 takenAt 升序遍历,维护 accountId→最近 totalUsd 的累积表,逐事件产出
// { t, total = Σ 当前表 }。同一 takenAt 的多账户事件先全部并入、只产一个点(避免同刻多点)。

export function buildAccountValueHistory(
  snapshots: { takenAt: number; totalUsd: number }[],
  since?: number,
): HistoryPoint[] {
  const rows: SnapshotTotalRow[] = snapshots
    .filter((s) => since == null || s.takenAt >= since)
    .map((s) => ({ accountId: "_", takenAt: s.takenAt, totalUsd: s.totalUsd }));
  return downsampleSeries(buildPortfolioHistory(rows));
}

// 归档 = 封存(ADR 0039):账户在归档那一刻之后**不再往曲线贡献**,归档之前的点原样保留。
//
// 为什么这件事非在这里做不可:上面那套阶梯重建会把每个账户的最后一个值**一直保持下去**,
// 而账户一旦归档就不再有新快照 —— 于是它那个冻住的值会跟着曲线一路走到今天。而曲线的当下点
// 是由实时总额覆写的、只算活跃账户。两边口径不一致的结果是:归档之后的每个历史点都含一个
// 幽灵值,只有最右边那个点排除了它,看上去就是「一路平着、到头凭空掉一截」。
//
// 传 `archivedAt`(只放已归档的账户)之后,过去点与当下点终于说的是同一件事,代价是**已有曲线
// 的形状会当场变样** —— 那正是要的:台阶落在真正归档的那一刻,而不是落在最右边。
//
// 用 `<=`:归档那一刻起就不算了。恰好落在该时刻的快照不再单独冒一个尖。
export function buildPortfolioHistory(
  rows: SnapshotTotalRow[],
  archivedAt: ReadonlyMap<string, number> = new Map(),
): HistoryPoint[] {
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
    for (const [accountId, v] of latestByAccount) {
      const archived = archivedAt.get(accountId);
      if (archived != null && archived <= row.takenAt) continue;
      total += v;
    }
    points.push({ t: row.takenAt, total });
  }

  return points;
}
