// 纯逻辑(无 server-only import → 可单测)。单币【持仓价值】历史:
// 把历史余额行按 token_id 归属,按 (账户×快照) 汇总【冻结】价值,再复用 buildPortfolioHistory
// 跨账户阶梯式重建 —— 与主页 hero 同语义(某时刻 = Σ 各账户在 ≤该时刻最近一次快照里的该币价值)。
//
// 归属用与聚合同一套 `groupKey` / `isEligible`,确保历史 ≡ 当前 Holding。认定在写快照时就定死了
// (ADR 0021 / #201),所以这里不再富化、不再解析 —— 历史行自己带着 token_id。
//
// 合并过的历史行也对得上:`TokenStore.merge` 会把历史快照的 token_id 一并改指
// (身份可变、金额不变),所以曲线不会在合并那一刻断成两段。
import { type AggInput, groupKey, isEligible } from "./aggregate";
import { buildPortfolioHistory, type HistoryPoint, type SnapshotTotalRow } from "./history";

export interface TokenHistRow extends AggInput {
  takenAt: number; // 该行所属快照时刻(账户 = account.id)
}

export function buildTokenValueHistory(rows: readonly TokenHistRow[], key: string): HistoryPoint[] {
  // 按 (账户, takenAt) 汇总匹配本 Holding 的 eligible 行的冻结 value → 喂阶梯重建。
  const bySnap = new Map<string, SnapshotTotalRow>();
  for (const row of rows) {
    if (!isEligible(row) || groupKey(row) !== key) continue;
    const k = `${row.account.id}|${row.takenAt}`;
    const cur = bySnap.get(k);
    if (cur) cur.totalUsd += row.value;
    else bySnap.set(k, { accountId: row.account.id, takenAt: row.takenAt, totalUsd: row.value });
  }
  return buildPortfolioHistory([...bySnap.values()]);
}
