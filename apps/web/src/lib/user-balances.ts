import type { SnapshotWithBalances } from "@folio/db";
import type { BalanceLike } from "./tokens";

// 用户当下「可展示余额」全集(纯逻辑,无 server import → 可单测):各账户最新快照的余额 ∪ manual 账户的
// 合成余额(manual 已退出快照,ADR 0018)。
//
// **三门同源收口**:enrich(经 injectManualSnapshots 进 byAccount)、warm(warmTokensForUser)、
// refresh(refreshStalePrices)必须喂**同一集合** —— 否则 enrich 标了 stale 的 manual 行 warm/refresh 够不到,
// pricesStale 永清不掉、客户端每次加载空转刷新(见 lib/tokens.ts 同门注)。warm 与 refresh 都经本函数,
// 保证两者结构一致,而非各自手拼(手拼正是 T2 首版漏掉 refresh 的成因)。
export function userDisplayBalances(
  snapshots: SnapshotWithBalances[],
  manualBalances: BalanceLike[],
): BalanceLike[] {
  return [...snapshots.flatMap((s) => s.balances), ...manualBalances];
}
