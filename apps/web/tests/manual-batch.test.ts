import { describe, expect, it } from "vitest";
import type { DerivableActivity } from "../src/lib/manual-activity";
import {
  type BatchDraft,
  findToken,
  planManualBatch,
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
  identifier: null,
  activities: [],
  ...o,
});

// 顺序自增 id 工厂(确定性,便于断言)。
const idFactory = () => {
  let n = 0;
  return () => `new-${n++}`;
};

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

describe("findToken(标识优先,退回大写 symbol)", () => {
  const tokens = [
    mkToken({ id: "a", symbol: "BTC", identifier: "bitcoin" }),
    mkToken({ id: "b", symbol: "ETH", identifier: null }),
  ];
  it("按 identifier 精确命中", () => {
    expect(findToken(tokens, { symbol: "x", unitPrice: 1, identifier: "bitcoin" })?.id).toBe("a");
  });
  it("无 identifier → 按大写 symbol 命中 identifier-less 持仓", () => {
    expect(findToken(tokens, { symbol: "eth", unitPrice: 1 })?.id).toBe("b");
  });
  it("draft 带 identifier 但无对应 → 不命中 symbol-only 同名(不自动收养)", () => {
    expect(
      findToken(tokens, { symbol: "ETH", unitPrice: 1, identifier: "ethereum" }),
    ).toBeUndefined();
  });
});

describe("planManualBatch", () => {
  const draft = (o: Partial<BatchDraft>): BatchDraft => ({
    token: { symbol: "BTC", unitPrice: 100, identifier: "bitcoin" },
    kind: "add",
    amount: 1,
    occurredAt: 10,
    ...o,
  });

  it("命中既有持仓 → 只出活动,无新建 token", () => {
    const existing = [mkToken({ id: "t1", symbol: "BTC", identifier: "bitcoin" })];
    const plan = planManualBatch(existing, [draft({ amount: 2 })], idFactory());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.newTokens).toEqual([]);
    expect(plan.activities).toEqual([
      { tokenId: "t1", kind: "add", amount: 2, price: null, occurredAt: 10, memo: null },
    ]);
  });

  it("未持有 token → 现建(id 由工厂给),活动指向新 id", () => {
    const plan = planManualBatch([], [draft({ amount: 3 })], idFactory());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.newTokens).toEqual([
      { id: "new-0", symbol: "BTC", unitPrice: 100, identifier: "bitcoin" },
    ]);
    expect(plan.activities[0].tokenId).toBe("new-0");
  });

  it("同批多条指向同一新 token → 只建一次", () => {
    const plan = planManualBatch(
      [],
      [
        draft({ kind: "add", amount: 3, occurredAt: 10 }),
        draft({ kind: "add", amount: 2, occurredAt: 20 }),
      ],
      idFactory(),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.newTokens).toHaveLength(1);
    expect(plan.activities.map((a) => a.tokenId)).toEqual(["new-0", "new-0"]);
  });

  it("整批拒:任一 reduce 在其时点超过运行持有(含顶下水既有 reduce)", () => {
    const existing = [
      mkToken({
        id: "t1",
        symbol: "ETH",
        identifier: "ethereum",
        activities: [
          { kind: "set", amount: 5, occurredAt: 100, createdAt: 1 },
          { kind: "reduce", amount: 5, occurredAt: 200, createdAt: 2 },
        ],
      }),
    ];
    // 补录一条过去的 reduce 4 @50(基线 0)→ 该 token 时间线超支 → 整批拒。
    const plan = planManualBatch(
      existing,
      [
        draft({
          token: { symbol: "ETH", unitPrice: 1, identifier: "ethereum" },
          kind: "reduce",
          amount: 4,
          occurredAt: 50,
        }),
      ],
      idFactory(),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.symbol).toBe("ETH");
  });

  it("新 draft 在同一 occurredAt 排在既有之后(不误判超支)", () => {
    const existing = [
      mkToken({
        id: "t1",
        symbol: "BTC",
        identifier: "bitcoin",
        activities: [{ kind: "set", amount: 1, occurredAt: 10, createdAt: 1 }],
      }),
    ];
    // 同 occurredAt=10 追加 reduce 1:排在既有 set 1 之后 → 运行持有 0,合法。
    const plan = planManualBatch(
      existing,
      [draft({ kind: "reduce", amount: 1, occurredAt: 10 })],
      idFactory(),
    );
    expect(plan.ok).toBe(true);
  });
});
