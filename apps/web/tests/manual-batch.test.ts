import { describe, expect, it } from "vitest";
import type { DerivableActivity } from "../src/lib/manual-activity";
import {
  findToken,
  planManualBatch,
  type ResolvedDraft,
  runningOk,
  type Token,
} from "../src/lib/manual-batch";

const act = (o: Partial<DerivableActivity>): DerivableActivity => ({
  kind: "add",
  amount: 0,
  occurredAt: 0,
  createdAt: 0,
  ...o,
});

const mkToken = (o: Partial<Token>): Token => ({
  id: "t1",
  symbol: "BTC",
  unitPrice: 1,
  activities: [],
  ...o,
});

describe("runningOk", () => {
  it("reduce 从不超支 → ok", () => {
    expect(
      runningOk([
        act({ kind: "set", amount: 5, occurredAt: 1 }),
        act({ kind: "reduce", amount: 3, occurredAt: 2 }),
      ]),
    ).toBe(true);
  });

  it("reduce 在其时点超过运行持有 → 不 ok", () => {
    expect(
      runningOk([
        act({ kind: "set", amount: 2, occurredAt: 1 }),
        act({ kind: "reduce", amount: 3, occurredAt: 2 }),
      ]),
    ).toBe(false);
  });

  it("时序按 occurredAt→createdAt(补录在过去 → 顶下水后续 reduce)", () => {
    // set 5 @t3, reduce 5 @t4 本合法;但补录 reduce 4 @t2(基线 0)→ 该点即超支。
    expect(
      runningOk([
        act({ kind: "set", amount: 5, occurredAt: 3 }),
        act({ kind: "reduce", amount: 5, occurredAt: 4 }),
        act({ kind: "reduce", amount: 4, occurredAt: 2 }),
      ]),
    ).toBe(false);
  });
});

// 认币已经在 mint 那一步做完(#203),这里只比 id。原来这个函数自己有一套「上游 id 优先、
// 退回同名 symbol」的启发式 —— 那是跟 mint 平行的第二套认币规则,两处一旦漂移就会认出两个答案。
describe("findToken(只比 mint 给的 id)", () => {
  const tokens = [mkToken({ id: "a", symbol: "BTC" }), mkToken({ id: "b", symbol: "ETH" })];

  it("按 tokenId 命中", () => {
    expect(findToken(tokens, { tokenId: "b", symbol: "ETH", unitPrice: 1 })?.id).toBe("b");
  });

  // symbol 相同但 mint 判成了两个币(如山寨合约)→ 绝不并到一起。
  it("symbol 相同但 id 不同 → 不命中", () => {
    expect(findToken(tokens, { tokenId: "zzz", symbol: "BTC", unitPrice: 1 })).toBeUndefined();
  });
});

describe("planManualBatch", () => {
  const draft = (o: Partial<ResolvedDraft>): ResolvedDraft => ({
    token: { tokenId: "tk_btc", symbol: "BTC", unitPrice: 100, ticket: "tkt-btc" },
    kind: "add",
    amount: 1,
    occurredAt: 10,
    ...o,
  });

  it("命中既有持仓 → 只出活动,不重复声明", () => {
    const existing = [mkToken({ id: "tk_btc", symbol: "BTC" })];
    const plan = planManualBatch(existing, [draft({ amount: 2 })]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.declare).toEqual([]);
    expect(plan.activities).toEqual([
      {
        tokenId: "tk_btc",
        kind: "add",
        amount: 2,
        price: null,
        fee: null,
        occurredAt: 10,
        memo: null,
      },
    ]);
  });

  it("本账户还没持有 → 声明一条,id 用 mint 给的(不自己造)", () => {
    const plan = planManualBatch([], [draft({ amount: 3 })]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.declare).toEqual([{ id: "tk_btc", symbol: "BTC", unitPrice: 100 }]);
    expect(plan.activities[0].tokenId).toBe("tk_btc");
  });

  it("同批多条指向同一个币 → 只声明一次(mint 恒给同一个 id)", () => {
    const plan = planManualBatch(
      [],
      [
        draft({ kind: "add", amount: 3, occurredAt: 10 }),
        draft({ kind: "add", amount: 2, occurredAt: 20 }),
      ],
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.declare).toHaveLength(1);
    expect(plan.activities.map((a) => a.tokenId)).toEqual(["tk_btc", "tk_btc"]);
  });

  it("整批拒:任一 reduce 在其时点超过运行持有(含顶下水既有 reduce)", () => {
    const existing = [
      mkToken({
        id: "tk_eth",
        symbol: "ETH",
        activities: [
          { kind: "set", amount: 5, occurredAt: 100, createdAt: 1 },
          { kind: "reduce", amount: 5, occurredAt: 200, createdAt: 2 },
        ],
      }),
    ];
    // 补录一条过去的 reduce 4 @50(基线 0)→ 该 token 时间线超支 → 整批拒。
    const plan = planManualBatch(existing, [
      draft({
        token: { tokenId: "tk_eth", symbol: "ETH", unitPrice: 1 },
        kind: "reduce",
        amount: 4,
        occurredAt: 50,
      }),
    ]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.symbol).toBe("ETH");
  });

  it("新 draft 在同一 occurredAt 排在既有之后(不误判超支)", () => {
    const existing = [
      mkToken({
        id: "tk_btc",
        symbol: "BTC",
        activities: [{ kind: "set", amount: 1, occurredAt: 10, createdAt: 1 }],
      }),
    ];
    // 同 occurredAt=10 追加 reduce 1:排在既有 set 1 之后 → 运行持有 0,合法。
    const plan = planManualBatch(existing, [draft({ kind: "reduce", amount: 1, occurredAt: 10 })]);
    expect(plan.ok).toBe(true);
  });
});
