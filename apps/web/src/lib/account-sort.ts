// 活跃账户排序(纯逻辑,可单测):按市值倒序,无特殊分档。归档账户不经此处(列表末尾独立分区展示)。
// 同市值 Array.sort 稳定 → 保持入参相对顺序。

export function sortActiveAccounts<T extends { totalUsd: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.totalUsd - a.totalUsd);
}
