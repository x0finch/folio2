// 纯逻辑(缝③,无 server/db import → 可单测)。manual 账户价值历史 compute-on-read(ADR 0018):
// value@T = quantity@T × price@T,quantity@T = 折叠 occurredAt ≤ T 的活动。改/删任一过去活动 →
// 下次读整条曲线重算,永不留 stale。产出的 (takenAt, totalUsd) 阶梯序列直接喂既有 buildPortfolioHistory
// —— manual 只是「换供货源」(别账户来自 snapshot 表,manual 来自账本现算),无需特殊合并。
import type { ManualActivityKind } from "@folio/db";
import type { SnapshotTotalRow } from "./history";
import { deriveAmount } from "./manual-activity";

// 折叠 + 定价所需的最小活动形。price 参与 price@T 降级链②,不参与数量折叠。
export interface HistoryActivity {
  kind: ManualActivityKind;
  amount: number;
  occurredAt: number;
  createdAt: number;
  price?: number | null;
}
export interface HistoryToken {
  unitPrice: number;
  identifier?: string | null;
  activities: HistoryActivity[];
}

// #148 就绪后由 server 注入:有 identifier 的 token 在时刻 T 的 oracle 历史价(取不到 → undefined 落降级链)。
export type HistoricalPriceAt = (identifier: string, t: number) => number | undefined;

// price@T 降级链(ADR 0018):① 有 identifier → oracle 历史价(#148,经 priceAt 注入)→ ② 账本中
// occurredAt ≤ T 最近一条**记了 price** 的活动 → ③ 当前 unitPrice 摊平。本片先落 ②③;#148 就绪切 ①。
export function tokenPriceAt(token: HistoryToken, t: number, priceAt?: HistoricalPriceAt): number {
  if (token.identifier && priceAt) {
    const p = priceAt(token.identifier, t); // ①
    if (p != null) return p;
  }
  let best: HistoryActivity | undefined; // ② 最近(occurredAt→createdAt)且记了 price 的活动
  for (const a of token.activities) {
    if (a.occurredAt > t || a.price == null) continue;
    if (
      !best ||
      a.occurredAt > best.occurredAt ||
      (a.occurredAt === best.occurredAt && a.createdAt > best.createdAt)
    ) {
      best = a;
    }
  }
  return best?.price ?? token.unitPrice; // ②(best.price 恒非空)否则 ③
}

// quantity@T:折叠 occurredAt ≤ T 的活动(deriveAmount 语义:set 重置 / add += / reduce -= / 末值夹 0)。
export function tokenQuantityAt(token: HistoryToken, t: number): number {
  return deriveAmount(token.activities.filter((a) => a.occurredAt <= t));
}

// 某 manual 账户的账本 → (takenAt, totalUsd) 阶梯序列:每个「有活动发生的不同时刻」一行(此刻起某 token
// 的数量或定价变化 → 账户净值变)。totalUsd@T = Σ_token quantity@T × price@T。空账户/无活动 → 空序列。
export function buildManualAccountSeries(
  accountId: string,
  tokens: HistoryToken[],
  priceAt?: HistoricalPriceAt,
): SnapshotTotalRow[] {
  const times = new Set<number>();
  for (const tk of tokens) for (const a of tk.activities) times.add(a.occurredAt);
  return [...times]
    .sort((a, b) => a - b)
    .map((t) => {
      let total = 0;
      for (const tk of tokens) total += tokenQuantityAt(tk, t) * tokenPriceAt(tk, t, priceAt);
      return { accountId, takenAt: t, totalUsd: total };
    });
}
