import type { ManualActivityKind } from "@folio/db";

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
