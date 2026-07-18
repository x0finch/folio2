// 活跃账户排序(纯逻辑,可单测)。规则:未同步过的(新添加、takenAt=null)置顶 → 其余按市值倒序。
// 归档账户不经此处(在列表末尾独立分区展示)。同档内 Array.sort 稳定 → 保持入参相对顺序。
// 未同步账户市值恒为 0,若纯按价值倒序会沉底,故先用"是否同步过"分档、再按价值排。

export function sortActiveAccounts<T extends { takenAt: number | null; totalUsd: number }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    // 0 = 未同步(置顶),1 = 已同步过。先按档,再按市值倒序。
    const rankA = a.takenAt == null ? 0 : 1;
    const rankB = b.takenAt == null ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    return b.totalUsd - a.totalUsd;
  });
}
