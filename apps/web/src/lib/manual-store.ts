import { type DerivableActivity, deriveAmount } from "./manual-activity";

// manual 多 token 抽屉的**内存态** store（前端原型，F 片；不落库，逐步迁 DB 见 D 片）。
// 纯逻辑（无 React / server-only import → 可单测）：id / 时间戳由调用方（hook）注入，保持确定性。
// 事实源是各 token 的活动账本；amount 恒 = deriveAmount(activities)（同 server materialize 语义）。

export interface StoredActivity extends DerivableActivity {
  id: string;
  memo?: string;
  // 成本基元数据(不参与 deriveAmount/validateBatch,纯数量之外的记账):每枚价格 + 可选手续费(USD)。
  // 供 Total 展示与后续 P/L 片使用;历史价的精确化见 #148。
  price?: number;
  fee?: number;
}

// 某 manual 账户持有的一个 token（定义 + 自己的活动账本）。
export interface Token {
  id: string;
  symbol: string;
  unitPrice: number;
  identifier?: string; // token 参考层寻址标识（选币带入）
  logo?: string;
  name?: string;
  activities: StoredActivity[];
}

export type ManualState = Token[];

// 合并账本的一行：活动 + 所属 token 标识（Activity tab 跨 token 展示）。
export interface MergedActivityRow extends StoredActivity {
  tokenId: string;
  symbol: string;
  logo?: string;
}

// 暂存批量里的一条草稿（Activity modal）。createdAt 由调用方按提交顺序赋值作 tiebreak。
export interface DraftActivity {
  tokenId: string;
  kind: StoredActivity["kind"];
  amount: number;
  occurredAt: number;
  createdAt: number;
  memo?: string;
  price?: number;
  fee?: number;
}

// 活动流的 token 引用（CGK 选币结果 + 市价单价）。活动可指向尚未持有的 token → 提交时按需建 token。
export interface DraftTokenRef {
  symbol: string;
  identifier?: string;
  logo?: string;
  name?: string;
  unitPrice: number;
}

// token 维度的活动草稿（Activity modal 用;不预设 token —— 未持有则 resolve 时创建）。
export interface ActivityDraft {
  token: DraftTokenRef;
  kind: StoredActivity["kind"];
  amount: number;
  occurredAt: number;
  createdAt: number;
  memo?: string;
  price?: number;
  fee?: number;
}

// 编辑 token 表单的取值（symbol/unitPrice/identifier + 目标 amount）。
export interface TokenInput {
  symbol: string;
  unitPrice: number;
  identifier?: string;
  logo?: string;
  name?: string;
  amount: number;
}

// 浮点折叠余量的容差：deriveAmount 末值夹 0，但校验须在夹之前判负。
const EPS = 1e-9;

export function tokenAmount(h: Token): number {
  return deriveAmount(h.activities);
}

// 新建 token：一条 occurredAt=now 的 set 种子活动，使 derived amount === 初始 amount。
export function makeSeedToken(
  id: string,
  seedActivityId: string,
  input: TokenInput,
  now: number,
): Token {
  return {
    id,
    symbol: input.symbol,
    unitPrice: input.unitPrice,
    identifier: input.identifier,
    logo: input.logo,
    name: input.name,
    activities: [
      { id: seedActivityId, kind: "set", amount: input.amount, occurredAt: now, createdAt: now },
    ],
  };
}

export function addToken(state: ManualState, token: Token): ManualState {
  return [...state, token];
}

export function removeToken(state: ManualState, tokenId: string): ManualState {
  return state.filter((h) => h.id !== tokenId);
}

// 改 token 定义；若目标 amount 与当前 derived 不同 → 追加一条 set 活动对齐（播 set 语义，见 grill Q13）。
export function updateToken(
  state: ManualState,
  tokenId: string,
  input: TokenInput,
  align: { id: string; occurredAt: number },
): ManualState {
  return state.map((h) => {
    if (h.id !== tokenId) return h;
    const current = tokenAmount(h);
    const activities =
      Math.abs(current - input.amount) > EPS
        ? [
            ...h.activities,
            {
              id: align.id,
              kind: "set" as const,
              amount: input.amount,
              occurredAt: align.occurredAt,
              createdAt: align.occurredAt,
            },
          ]
        : h.activities;
    return {
      ...h,
      symbol: input.symbol,
      unitPrice: input.unitPrice,
      identifier: input.identifier,
      logo: input.logo,
      name: input.name,
      activities,
    };
  });
}

export function deleteActivity(
  state: ManualState,
  tokenId: string,
  activityId: string,
): ManualState {
  return state.map((h) =>
    h.id === tokenId ? { ...h, activities: h.activities.filter((a) => a.id !== activityId) } : h,
  );
}

// 编辑一笔既有活动的字段(保留 id/createdAt;kind/amount/occurredAt/memo/price/fee 可改)。
export function updateActivity(
  state: ManualState,
  tokenId: string,
  activityId: string,
  patch: Partial<Omit<StoredActivity, "id">>,
): ManualState {
  return state.map((h) =>
    h.id !== tokenId
      ? h
      : {
          ...h,
          activities: h.activities.map((a) => (a.id === activityId ? { ...a, ...patch } : a)),
        },
  );
}

// 单个 token 的时间线是否合法(无 reduce 在其时点超支)。供编辑既有活动后校验(改 amount/kind/日期可能致超支)。
export function tokenValid(state: ManualState, tokenId: string): boolean {
  const h = state.find((x) => x.id === tokenId);
  if (!h) return true;
  const sorted = [...h.activities].sort(
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

export function mergedActivities(state: ManualState): MergedActivityRow[] {
  const rows = state.flatMap((h) =>
    h.activities.map((a) => ({ ...a, tokenId: h.id, symbol: h.symbol, logo: h.logo })),
  );
  return rows.sort((a, b) => b.occurredAt - a.occurredAt || b.createdAt - a.createdAt);
}

// 整批校验：把现有活动 + 草稿合并成每 token 的时间线，按 occurredAt→createdAt 折叠，
// 任一 reduce 在其时点使运行持有 < 0（含被早于其发生的草稿顶下水的既有 reduce）→ 整批拒。
export function validateBatch(
  state: ManualState,
  drafts: DraftActivity[],
): { ok: true } | { ok: false; tokenId: string; symbol: string } {
  const byToken = new Map<string, DerivableActivity[]>();
  for (const h of state) byToken.set(h.id, [...h.activities]);
  drafts.forEach((d) => {
    const list = byToken.get(d.tokenId);
    if (list)
      list.push({
        kind: d.kind,
        amount: d.amount,
        occurredAt: d.occurredAt,
        createdAt: d.createdAt,
      });
  });
  for (const h of state) {
    const sorted = [...(byToken.get(h.id) ?? [])].sort(
      (a, b) => a.occurredAt - b.occurredAt || a.createdAt - b.createdAt,
    );
    let running = 0;
    for (const a of sorted) {
      if (a.kind === "set") running = a.amount;
      else if (a.kind === "add") running += a.amount;
      else {
        running -= a.amount;
        if (running < -EPS) return { ok: false, tokenId: h.id, symbol: h.symbol };
      }
    }
  }
  return { ok: true };
}

// 把已校验的草稿批量追加为活动（id 由 mkId 按序生成）。
export function commitBatch(
  state: ManualState,
  drafts: DraftActivity[],
  mkId: (index: number) => string,
): ManualState {
  const perToken = new Map<string, StoredActivity[]>();
  drafts.forEach((d, i) => {
    const list = perToken.get(d.tokenId) ?? [];
    list.push({
      id: mkId(i),
      kind: d.kind,
      amount: d.amount,
      occurredAt: d.occurredAt,
      createdAt: d.createdAt,
      memo: d.memo,
      price: d.price,
      fee: d.fee,
    });
    perToken.set(d.tokenId, list);
  });
  return state.map((h) => {
    const extra = perToken.get(h.id);
    return extra ? { ...h, activities: [...h.activities, ...extra] } : h;
  });
}

// 建一个空账本 token（活动流为未持有 token 现建;首笔活动本身即基线,故不 seed set）。
export function makeToken(id: string, token: DraftTokenRef): Token {
  return {
    id,
    symbol: token.symbol,
    unitPrice: token.unitPrice,
    identifier: token.identifier,
    logo: token.logo,
    name: token.name,
    activities: [],
  };
}

// 按 identifier（优先）或 symbol（无 identifier 时,大小写无关）匹配已有 token。
export function findToken(state: ManualState, token: DraftTokenRef): Token | undefined {
  if (token.identifier) return state.find((h) => h.identifier === token.identifier);
  const sym = token.symbol.toUpperCase();
  return state.find((h) => !h.identifier && h.symbol.toUpperCase() === sym);
}

// token 维度草稿 → token 维度:为尚未持有的 token 现建空 token(mkTokenId 按新建序号生成 id),
// 返回补齐后的 state + tokenId 维度草稿(供 validateBatch/commitBatch 复用同一套折叠/入库逻辑)。
export function resolveActivityDrafts(
  state: ManualState,
  drafts: ActivityDraft[],
  mkTokenId: (index: number) => string,
): { state: ManualState; tokenDrafts: DraftActivity[] } {
  let next = state;
  let created = 0;
  const tokenDrafts: DraftActivity[] = [];
  for (const d of drafts) {
    let h = findToken(next, d.token);
    if (!h) {
      h = makeToken(mkTokenId(created), d.token);
      created += 1;
      next = addToken(next, h);
    }
    tokenDrafts.push({
      tokenId: h.id,
      kind: d.kind,
      amount: d.amount,
      occurredAt: d.occurredAt,
      createdAt: d.createdAt,
      memo: d.memo,
      price: d.price,
      fee: d.fee,
    });
  }
  return { state: next, tokenDrafts };
}
