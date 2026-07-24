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

// token 定义 + 其活动账本 → creds.tokens 的一项(物化投影,ADR 0017)。
// amount = deriveAmount(activities);identifier 为空(null/undefined)时**省略该键** —— provider 的 tokens
// validator 视 identifier 为可选 string(置 null 会被拒)。纯逻辑,materializeManualCreds 逐 token 调。
export interface ManualTokenDef {
  symbol: string;
  unitPrice: number;
  identifier?: string | null;
}
export interface CredsToken {
  symbol: string;
  unitPrice: number;
  amount: number;
  identifier?: string;
}
export function projectToken(token: ManualTokenDef, activities: DerivableActivity[]): CredsToken {
  return {
    symbol: token.symbol,
    unitPrice: token.unitPrice,
    amount: deriveAmount(activities),
    ...(token.identifier ? { identifier: token.identifier } : {}),
  };
}
