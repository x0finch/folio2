// 账户行状态派生(纯逻辑,可单测)。决定状态行显示哪条文本 + 是否染 --warn 警示色。
// 优先级:缺凭据(可导入带数据但需补录)> 无快照(从未同步)> 陈旧(超阈值)> 新鲜。
// 缺凭据与陈旧可并存 —— 缺凭据是更该处理的信号,优先。takenAt 为 server 冻结时刻,nowMs 由调用方传入(可测)。

// 同步陈旧阈值:距上次同步超过 24h 视为陈旧(数据可能过时)→ 状态行前置 ⚠ + warn 色。
export const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

export type AccountSyncStatus = "needsCreds" | "never" | "stale" | "fresh";

export function accountSyncStatus(
  account: { needsCredentials: boolean; takenAt: number | null },
  nowMs: number,
): AccountSyncStatus {
  if (account.needsCredentials) return "needsCreds";
  if (account.takenAt == null) return "never";
  return nowMs - account.takenAt > STALE_SYNC_MS ? "stale" : "fresh";
}
