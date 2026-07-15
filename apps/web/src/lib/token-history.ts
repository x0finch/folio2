// 纯逻辑(无 server-only import → 可单测)。单币【持仓价值】历史:
// 把历史余额行(已富化成 AggInput + 快照时刻)按 Holding key 归属,按 (账户×快照) 汇总【冻结】价值,
// 再复用 buildPortfolioHistory 跨账户阶梯式重建 —— 与主页 hero 同语义(某时刻 = Σ 各账户在
// ≤该时刻最近一次快照里的该币价值)。归属用与聚合同一套 holdingKey/isEligible,确保历史 ≡ 当前 Holding。
import { type AggInput, holdingKey, isEligible } from "./aggregate";
import { buildPortfolioHistory, type HistoryPoint, type SnapshotTotalRow } from "./history";

export interface TokenHistRow extends AggInput {
  takenAt: number; // 该行所属快照时刻(账户 = account.id)
}

export function buildTokenValueHistory(rows: readonly TokenHistRow[], key: string): HistoryPoint[] {
  // 按 (账户, takenAt) 汇总匹配本 Holding 的 eligible 行的冻结 value → 喂阶梯重建。
  const bySnap = new Map<string, SnapshotTotalRow>();
  for (const row of rows) {
    if (!isEligible(row) || holdingKey(row) !== key) continue;
    const k = `${row.account.id}|${row.takenAt}`;
    const cur = bySnap.get(k);
    if (cur) cur.totalUsd += row.value;
    else bySnap.set(k, { accountId: row.account.id, takenAt: row.takenAt, totalUsd: row.value });
  }
  return buildPortfolioHistory([...bySnap.values()]);
}
