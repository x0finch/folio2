import type { ManualActivityKind } from "@folio/db";
import type { DerivableActivity } from "../../manual-activity";

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

// 既有持仓(定义 + 活动账本),供解析/折叠。`id` 就是 `tokens.id`。
export interface Token {
  id: string;
  symbol: string;
  activities: DerivableActivity[];
}

// 草稿指向的**选中币** —— 这是 server fn 的入参形状(客户端给什么就是什么)。
// `ticket` 是选币下拉发的那串不透明票(见 lib/token-option.ts);本模块不解释它,只搬运。
interface PickedTokenInput {
  symbol: string;
  unitPrice: number;
  ticket?: string | null;
}

// 认过币之后的选中币:`tokenId` 由调用方在规划**之前**经 mint 换出(见 manualTokenRef)。
// 于是「这条草稿指的是哪个币」不再由本模块猜 —— 原来这里按上游 id 优先、退回同名 symbol 匹配,
// 那是一套跟 mint 平行的认币启发式,两处规则一旦漂移就会一个认成 A、一个认成 B。
export type ResolvedTokenInput = PickedTokenInput & { tokenId: string };

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

// 已认过币的草稿 —— planManualBatch 收的是这个。
export type ResolvedDraft = Omit<BatchDraft, "token"> & { token: ResolvedTokenInput };

// 写计划:本批要**声明**的持仓(id 是已经 mint 出来的 token id;活动据此引用)。
interface PlannedToken {
  id: string;
  symbol: string;
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
  | { ok: true; declare: PlannedToken[]; activities: PlannedActivity[] };

// 认币已在 mint 完成 → 这里只比 id。同一个币在同一账户里恒命中同一条既有持仓,
// 而「同名但不是同一个币」也不会被误收养 —— mint 那一档已经判过(合约不许按 symbol 猜)。
export function findToken(tokens: Token[], ref: ResolvedTokenInput): Token | undefined {
  return tokens.find((t) => t.id === ref.tokenId);
}

// 把一批草稿解析成写计划:逐条命中/现建 token,合成校验时间线(新活动排在同 occurredAt 既有之后、按提交序),
// 任一 token 时间线超支 → 整批拒(返回超支 symbol);否则出新建 token + 待插入活动。
export function planManualBatch(existing: Token[], drafts: ResolvedDraft[]): BatchPlan {
  // 工作副本:既有活动浅拷,追加草稿以校验;不改入参。
  const working: Token[] = existing.map((t) => ({ ...t, activities: [...t.activities] }));
  const declare: PlannedToken[] = [];
  const activities: PlannedActivity[] = [];
  // 校验时间线里,新草稿的 createdAt 取一段远大于任何真实 epoch-ms createdAt 的序号,
  // 从而在同 occurredAt 处恒排在既有活动之后、且彼此按提交序 —— 与入库(createdAt = now+i)的定序一致。
  const draftSeqBase = Number.MAX_SAFE_INTEGER - drafts.length;

  drafts.forEach((d, i) => {
    let token = findToken(working, d.token);
    if (!token) {
      // 这个币在本账户还没有持仓 → 声明一条。**id 不在这里造** —— 它是 mint 给的,
      // 所以同一个币被两条草稿引用时天然落到同一条持仓上。
      //
      // **不在这里替用户声明价格。** 一度试过「没有市价就把这笔活动的成交价抄进 self_price」——
      // 那是把派生值存进字段:第一笔活动抄了个 0 进去之后,后面记多少笔都治不好它(实测 SSGS)。
      // 「市场不认识这个币时它值多少」由展示那一侧**每次算**(见 manual-activity 的 fallbackUnitPrice),
      // 不落库。这里只忠实记录用户声明了什么 —— 没声明就是 null。
      token = { id: d.token.tokenId, symbol: d.token.symbol, activities: [] };
      working.push(token);
      declare.push({ id: token.id, symbol: token.symbol });
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
  return { ok: true, declare, activities };
}
