import type { ConnectorId } from "@folio/connectors";
import type { ManualActivityKind } from "@folio/db";
import type { SnapshotTotalRow } from "./history";

// manual connector 的 id —— app 侧「是不是 manual 账户」判别的**单一事实源**。
// manual = 值靠 creds 现造、不联网同步的账户(ADR 0018);Q2 决定用 app 侧写死判别而非 manifest 能力位,
// 故散落各处的 connectorId === "manual" 全收此,避免字面量遍地。
//
// **这一段只放身份判别,不放写路径的东西。** 它被组件 import(渲染哪套字段要问「是不是手记」),
// 所以它拖进来的依赖会跟着进客户端的依赖图。原来这里还住着 `manualTokenRef`,于是每个 import
// `isManual` 的组件都顺带依赖了 tokenRef 文法包 —— tree-shaking 当时摘掉了它,但那是打包器的结果、
// 不是不变量:这文件哪天多一行副作用,文法就悄悄跟着出去了。造 ref 是写路径的活,
// 已挪到它唯一的调用者旁边(`server/internal/manual.ts`)。
export const MANUAL_CONNECTOR_ID = "manual" satisfies ConnectorId;

export function isManual(connectorId: ConnectorId): boolean {
  return connectorId === MANUAL_CONNECTOR_ID;
}

// 纯逻辑(无 server-only import → 可单测)。manual 活动账本 → 当前数量。
// 语义:按 occurred_at(同值用 created_at)升序处理;`set` 重置基线(其前活动作废)、
// `add` +=、`reduce` -=;无 set 则基线 0。**每步夹 max(0)**:持仓不为负 —— 某笔 reduce 超卖即当步归零,
// 不把负值(欠账)带到后续活动。写路径有 runningOk 挡超卖,但删除更早活动(如开仓 set)会**回溯**造成超卖
// (delete 不重校验),此时逐步夹 0 才给出直觉值(1 卖 2 归 0、再买 1 = 1),而非末值夹 0 的 (1−2+1)=0。
export interface DerivableActivity {
  kind: ManualActivityKind;
  amount: number;
  occurredAt: number;
  createdAt: number;
}

export function deriveAmount(activities: DerivableActivity[]): number {
  const sorted = [...activities].sort(
    (a, b) => a.occurredAt - b.occurredAt || a.createdAt - b.createdAt,
  );
  let amount = 0;
  for (const a of sorted) {
    if (a.kind === "set") amount = a.amount;
    else if (a.kind === "add") amount += a.amount;
    else amount -= a.amount; // reduce
    if (amount < 0) amount = 0; // 每步夹 0:超卖当步归零,不把负债带到后续活动
  }
  return amount;
}

// token 定义 + 其活动账本 → 合成持仓的一项。amount = deriveAmount(activities)。
//
// `id` 是 `tokens.id`(#203 起手记的币就是那张表里的一行)。**必须一路带到合成余额上** ——
// 展示富化 / 预热 / 刷价三个门全按 `tokenId` 收口,不带就等于这个币不存在:没有上游名字、
// 没有 logo、也没人去给它取价。
//
// `ref` 是这个 token 在当前命名者那里的 ref 整条,由 db 直接给(见 `ManualHolding.ref`)——
// 本模块**只搬运**:不拼、不拆、不知道命名者是谁。认不出来 → null。
export interface ManualTokenDef {
  id: string;
  symbol: string;
  ref?: string | null;
}
export interface CredsToken {
  id: string;
  symbol: string;
  amount: number;
  // 市场不认识这个币时用哪个价 —— 已经按下面那条链解好了。空 = 一个来源都没有。
  fallbackPrice: number | null;
  ref: string | null;
}

/**
 * 市场不认识这个币时,一单位值多少 —— **账本里最近一条记了价的活动**。
 *
 * 「这个币值多少」只有一个来源:账本。开仓价是账本的第一笔,后续成交价是后面几笔,答案恒取最新。
 * 原来还有第二个来源(`tokens.self_price`,加账户表单直接写),于是同一件事两处存、其中一处
 * 可以存歪 —— SSGS 那行卡在 0 上、后面记多少笔都治不好,就是这么来的。那一列现在没有写者
 * (存量由迁移 0016 搬进账本)。
 *
 * 与历史曲线那条链(`manual-history` 的 `tokenPriceAt`)一致:那里的 ② 就是这一档,
 * 只是它按任意 T 取、这里按 now 取。
 */
export function fallbackUnitPrice(
  activities: readonly (DerivableActivity & { price?: number | null })[],
): number | null {
  // 最近一条**记了价**的活动(同 occurredAt 用 createdAt 决胜,与折叠数量同口径)。
  let best: (DerivableActivity & { price?: number | null }) | undefined;
  for (const a of activities) {
    if (a.price == null) continue;
    if (
      !best ||
      a.occurredAt > best.occurredAt ||
      (a.occurredAt === best.occurredAt && a.createdAt > best.createdAt)
    ) {
      best = a;
    }
  }
  return best?.price ?? null;
}

export function projectToken(
  token: ManualTokenDef,
  activities: readonly (DerivableActivity & { price?: number | null })[],
): CredsToken {
  return {
    id: token.id,
    symbol: token.symbol,
    amount: deriveAmount([...activities]),
    fallbackPrice: fallbackUnitPrice(activities),
    ref: token.ref ?? null,
  };
}

// 纯逻辑(缝③,无 server/db import → 可单测)。manual 账户价值历史 compute-on-read(ADR 0018/0019):
// value@T = quantity@T × price@T,quantity@T = 折叠 occurredAt ≤ T 的活动。改/删任一过去活动 →
// 下次读整条曲线重算,永不留 stale。产出的 (takenAt, totalUsd) 阶梯序列直接喂既有 buildPortfolioHistory
// —— manual 只是「换供货源」(别账户来自 snapshot 表,manual 来自账本现算),无需特殊合并。
//
// ADR 0019:采样轴从「交易时刻」改为**区间驱动的规则日网格**—— 组合净值曲线的形状主要来自价格波动而非交易,
// 按交易时刻采样会漏掉活动之间的市价起伏(一年一次交易只出一个点)。日网格覆盖 [首活动日, now],数量投影
// 到每个网格日,价由注入的 oracle 历史价(#148)驱动;网格天然覆盖 since→now,顺带修掉「窗口外存量被丢」缺口。

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
  id: string; // tokens.id —— 历史价按它取(#203)
  unitPrice: number;
  // 上游认不认识这个币。false = 认不出来 → 没有历史价可问,跳过降级链第 ① 档。
  // 原来这里是「当前上游对它的叫法」,但本模块从没用过那个字符串本身,只判它空不空 ——
  // 一个字符串字段装一个布尔含义,还逼两处调用方各自去凑一个「叫法」出来(#202b)。
  recognized?: boolean;
  // 法币身份(ADR 0026 / #274):非空 = 这是白名单法币现金,历史价走**当天汇率**而非币价。
  // 纯层不认识它 —— 定价仍由注入的 `priceAt` 出(server 侧对法币灌的是 fx),这个字段只在
  // server 侧的 `buildHistoricalPriceAt` 决定「问汇率还是问币价」。法币恒 `recognized: true`。
  fiatCode?: string;
  activities: HistoryActivity[];
}

// 由 server 注入(#148 / ADR 0019):某 token 在时刻 T 的 oracle 历史价(取不到 → undefined 落降级链)。
// server 侧按区间一次预取 priceSeries → 建 Map<tokenId, Map<dayBucket, price>>,再包成本同步闭包。
export type HistoricalPriceAt = (tokenId: string, t: number) => number | undefined;

// price@T 降级链(ADR 0019):① 上游认识它 → oracle 历史价(#148,经 priceAt 注入,市值主路径)→ ② 账本中
// occurredAt ≤ T 最近一条**记了 price** 的活动(兜底 + 成本原料)→ ③ 当前 unitPrice 摊平(真无市场,平线)。
export function tokenPriceAt(token: HistoryToken, t: number, priceAt?: HistoricalPriceAt): number {
  if (token.recognized && priceAt) {
    const p = priceAt(token.id, t); // ①
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

// quantity@T:折叠 occurredAt ≤ T 的活动(deriveAmount 语义:set 重置 / add += / reduce -= / 逐步夹 0)。
export function tokenQuantityAt(token: HistoryToken, t: number): number {
  return deriveAmount(token.activities.filter((a) => a.occurredAt <= t));
}

// 账户在时刻 t 的总额:Σ_token quantity@t × price@t(价走降级链 ①oracle→②账本→③unitPrice)。
// 网格序列与活动明细「此时总额」共用。
export function accountTotalAt(
  tokens: HistoryToken[],
  t: number,
  priceAt?: HistoricalPriceAt,
): number {
  let total = 0;
  for (const tk of tokens) total += tokenQuantityAt(tk, t) * tokenPriceAt(tk, t, priceAt);
  return total;
}

// 某 token 账本里,某笔活动是否「卖超」:该笔为 reduce,且其数量 > 此前(逐步夹 0 后的)运行持有 ——
// 即这笔减少会把持有压到 0、且仍有卖不掉的余量。用于活动明细里如实提示(不改折叠结果)。
export function isReduceOversold(
  activities: HistoryActivity[],
  activity: Pick<HistoryActivity, "kind" | "amount" | "occurredAt" | "createdAt">,
): boolean {
  if (activity.kind !== "reduce") return false;
  const before = activities.filter(
    (a) =>
      a.occurredAt < activity.occurredAt ||
      (a.occurredAt === activity.occurredAt && a.createdAt < activity.createdAt),
  );
  return deriveAmount(before) < activity.amount;
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
    .map((t) => ({ accountId, takenAt: t, totalUsd: accountTotalAt(tokens, t, priceAt) }));
}
