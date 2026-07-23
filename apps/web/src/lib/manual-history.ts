// 纯逻辑(缝③,无 server/db import → 可单测)。manual 账户价值历史 compute-on-read(ADR 0018/0019):
// value@T = quantity@T × price@T,quantity@T = 折叠 occurredAt ≤ T 的活动。改/删任一过去活动 →
// 下次读整条曲线重算,永不留 stale。产出的 (takenAt, totalUsd) 阶梯序列直接喂既有 buildPortfolioHistory
// —— manual 只是「换供货源」(别账户来自 snapshot 表,manual 来自账本现算),无需特殊合并。
//
// ADR 0019:采样轴从「交易时刻」改为**区间驱动的规则日网格**—— 组合净值曲线的形状主要来自价格波动而非交易,
// 按交易时刻采样会漏掉活动之间的市价起伏(一年一次交易只出一个点)。日网格覆盖 [首活动日, now],数量投影
// 到每个网格日,价由注入的 oracle 历史价(#148)驱动;网格天然覆盖 since→now,顺带修掉「窗口外存量被丢」缺口。
import type { ManualActivityKind } from "@folio/db";
import type { SnapshotTotalRow } from "./history";
import { deriveAmount } from "./manual-activity";

// UTC 日网格步长。与 @folio/oracle-basic 的 dayBucketOf(floor(ms / 86_400_000))同口径 —— 一日的毫秒数是
// 恒定算术常量(非会漂移的约定),故本纯模块自持一份、不引 oracle 包;server 注入的 priceAt 用 oracle 的
// dayBucketOf 归桶,二者按构造对齐(网格 τ 落在桶 b ⇔ floor(τ/MS_PER_DAY)===b)。
const MS_PER_DAY = 86_400_000;

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

// 由 server 注入(#148 / ADR 0019):有 identifier 的 token 在时刻 T 的 oracle 历史价(取不到 → undefined 落降级链)。
// server 侧按区间一次预取 priceSeries → 建 Map<identifier, Map<dayBucket, price>>,再包成本同步闭包。
export type HistoricalPriceAt = (identifier: string, t: number) => number | undefined;

// price@T 降级链(ADR 0019):① 有 identifier → oracle 历史价(#148,经 priceAt 注入,市值主路径)→ ② 账本中
// occurredAt ≤ T 最近一条**记了 price** 的活动(兜底 + 成本原料)→ ③ 当前 unitPrice 摊平(真无市场,平线)。
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

// 某 manual 账户的账本 → (takenAt, totalUsd) 序列,在**规则日网格**上采样(ADR 0019):曲线随市价起伏而非
// 只在交易时刻跳变。采样时刻 = **首活动锚点** ∪ 其后每个 UTC 日末 ∪ now,取并集升序:
//  · 首活动锚点 —— 曲线从真正开仓时刻起(当日新账户也有起点),而非当日日末;
//  · 逐日日末 —— 给价格曲线形状(activity 之间的市价起伏);
//  · now —— 末点(数量/价到当下,server 再用实时盯市覆写)。
// 任一有活动的账户至少产「首活动 + now」两点 → 抽屉的 series.length ≥ 2 渲染门恒满足(修当日新账户空图)。
// 每点 totalUsd = Σ_token quantity@t × price@t(数量折叠 occurredAt ≤ t;价走 oracle 历史价@日桶,降级 ②③)。
// 空账户 / 无活动 → 空序列。网格覆盖全史 → 下游按 since 裁窗、downsample 压点;since 之后的点仍反映其前活动
// 折出的存量(修掉 T5「窗口外存量被丢」缺口)。
export function buildManualAccountSeries(
  accountId: string,
  tokens: HistoryToken[],
  now: number,
  priceAt?: HistoricalPriceAt,
): SnapshotTotalRow[] {
  let firstOccurred = Number.POSITIVE_INFINITY;
  for (const tk of tokens)
    for (const a of tk.activities) firstOccurred = Math.min(firstOccurred, a.occurredAt);
  if (!Number.isFinite(firstOccurred) || firstOccurred > now) return []; // 无活动 / 活动全在未来

  const times = new Set<number>([firstOccurred, now]); // 首活动锚点 + 末点(保证 ≥2 采样)
  const firstBucket = Math.floor(firstOccurred / MS_PER_DAY);
  const nowBucket = Math.floor(now / MS_PER_DAY);
  for (let b = firstBucket; b <= nowBucket; b++) {
    // 当日日末(next-day 起点前 1ms),夹到 now → floor(t/MS_PER_DAY)===b(与注入 priceAt 的日桶对齐)。
    const t = Math.min((b + 1) * MS_PER_DAY - 1, now);
    if (t > firstOccurred) times.add(t); // 只收首活动之后的日末(之前无持仓)
  }

  return [...times]
    .sort((a, b) => a - b)
    .map((t) => {
      let total = 0;
      for (const tk of tokens) total += tokenQuantityAt(tk, t) * tokenPriceAt(tk, t, priceAt);
      return { accountId, takenAt: t, totalUsd: total };
    });
}
