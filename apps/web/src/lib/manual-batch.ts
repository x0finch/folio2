import type { ManualActivityKind } from "@folio/db";
import type { DerivableActivity } from "./manual-activity";

// 服务端**批量写路径**的纯逻辑(无 server-only import → workers-pool 外可单测,与 injector/预热同源那套解耦)。
// 输入既有 token + 一批草稿,输出「写计划」(要新建的 token + 要插入的活动)或整批拒因(超支的 symbol)。
// 决策全在此,server fn / db op 只执行(ADR 0017 「决策逻辑下沉纯模块」)。

// 浮点折叠余量容差:runningOk 是写时超卖闸(deriveAmount 会把超卖逐步夹到 0、隐去负值),故校验须独立判负。
const EPS = 1e-9;

// 运行持有从不为负(reduce 不在任一时点超支)。按 occurredAt→createdAt 折叠;`set` 重置基线、`add` +=、`reduce` -=。
export function runningOk(activities: DerivableActivity[]): boolean {
  const sorted = [...activities].sort(
    (a, b) => a.occurredAt - b.occurredAt || a.createdAt - b.createdAt,
  );
  let running = 0;
  for (const a of sorted) {
    if (a.kind === "set") running = a.amount;
    else if (a.kind === "add") running += a.amount;
    else {
      running -= a.amount;
      if (running < -EPS) return false;
    }
  }
  return true;
}

// 既有 token(定义 + 活动账本),供解析/折叠。identifier 可空(symbol-only token)。
export interface Token {
  id: string;
  symbol: string;
  unitPrice: number;
  identifier?: string | null;
  activities: DerivableActivity[];
}

// 草稿指向的**选中币**(symbol + 市价单价 + 可选 CGK id)。可指向尚未持有的 token → 现建。
// 与 tokenRef(代币命名法,见 @folio/oracle-ref)无关 —— 这是 server fn 入参,不是代币身份串。
export interface PickedTokenInput {
  symbol: string;
  unitPrice: number;
  identifier?: string | null;
}

// 一条批量草稿:token 引用 + 活动字段(createdAt 不由客户端定,服务端按提交序赋值)。
export interface BatchDraft {
  token: PickedTokenInput;
  kind: ManualActivityKind;
  amount: number;
  occurredAt: number;
  price?: number | null;
  fee?: number | null;
  memo?: string | null;
}

// 写计划:要新建的 token(id 由调用方注入的工厂给,活动据此引用)。
interface PlannedToken {
  id: string;
  symbol: string;
  unitPrice: number;
  identifier?: string | null;
}
interface PlannedActivity {
  tokenId: string;
  kind: ManualActivityKind;
  amount: number;
  price?: number | null;
  fee?: number | null;
  occurredAt: number;
  memo?: string | null;
}
export type BatchPlan =
  | { ok: false; symbol: string }
  | { ok: true; newTokens: PlannedToken[]; activities: PlannedActivity[] };

// 按 identifier(优先,精确)匹配,退回大写 symbol(仅在无 identifier 时,匹配同样 identifier-less 的 token)。
// 带 identifier 的 ref 只按 identifier 命中,不自动收养 symbol-only 同名(与建账户/物化的身份归一一致)。
export function findToken(tokens: Token[], ref: PickedTokenInput): Token | undefined {
  if (ref.identifier) return tokens.find((t) => t.identifier === ref.identifier);
  const sym = ref.symbol.toUpperCase();
  return tokens.find((t) => !t.identifier && t.symbol.toUpperCase() === sym);
}

// 把一批草稿解析成写计划:逐条命中/现建 token,合成校验时间线(新活动排在同 occurredAt 既有之后、按提交序),
// 任一 token 时间线超支 → 整批拒(返回超支 symbol);否则出新建 token + 待插入活动。
export function planManualBatch(
  existing: Token[],
  drafts: BatchDraft[],
  newId: () => string,
): BatchPlan {
  // 工作副本:既有活动浅拷,追加草稿以校验;不改入参。
  const working: Token[] = existing.map((t) => ({ ...t, activities: [...t.activities] }));
  const newTokens: PlannedToken[] = [];
  const activities: PlannedActivity[] = [];
  // 校验时间线里,新草稿的 createdAt 取一段远大于任何真实 epoch-ms createdAt 的序号,
  // 从而在同 occurredAt 处恒排在既有活动之后、且彼此按提交序 —— 与入库(createdAt = now+i)的定序一致。
  const draftSeqBase = Number.MAX_SAFE_INTEGER - drafts.length;

  drafts.forEach((d, i) => {
    let token = findToken(working, d.token);
    if (!token) {
      const id = newId();
      token = {
        id,
        symbol: d.token.symbol,
        unitPrice: d.token.unitPrice,
        identifier: d.token.identifier ?? null,
        activities: [],
      };
      working.push(token);
      newTokens.push({
        id,
        symbol: token.symbol,
        unitPrice: token.unitPrice,
        identifier: token.identifier,
      });
    }
    activities.push({
      tokenId: token.id,
      kind: d.kind,
      amount: d.amount,
      price: d.price ?? null,
      fee: d.fee ?? null,
      occurredAt: d.occurredAt,
      memo: d.memo ?? null,
    });
    token.activities.push({
      kind: d.kind,
      amount: d.amount,
      occurredAt: d.occurredAt,
      createdAt: draftSeqBase + i,
    });
  });

  for (const t of working) {
    if (!runningOk(t.activities)) return { ok: false, symbol: t.symbol };
  }
  return { ok: true, newTokens, activities };
}
