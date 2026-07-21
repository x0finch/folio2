import { describe, expect, it } from "vitest";
import {
  type ActivityDraft,
  addHolding,
  commitBatch,
  type DraftActivity,
  deleteActivity,
  findHolding,
  type Holding,
  holdingAmount,
  holdingValid,
  makeSeedHolding,
  mergedActivities,
  removeHolding,
  resolveActivityDrafts,
  updateActivity,
  updateHolding,
  validateBatch,
} from "../src/lib/manual-store";

// 测试辅助:确定性 id(注入,避免依赖 crypto.randomUUID)。
const holding = (id: string, symbol: string, acts: Holding["activities"]): Holding => ({
  id,
  symbol,
  unitPrice: 1,
  activities: acts,
});
const act = (
  id: string,
  kind: "add" | "reduce" | "set",
  amount: number,
  occurredAt: number,
  createdAt = 0,
  memo?: string,
) => ({ id, kind, amount, occurredAt, createdAt, memo });

describe("holdingAmount", () => {
  it("derives from the holding's own ledger", () => {
    const h = holding("h1", "BTC", [act("a", "set", 2, 1), act("b", "add", 0.5, 2)]);
    expect(holdingAmount(h)).toBe(2.5);
  });
});

describe("makeSeedHolding", () => {
  it("creates a holding whose derived amount equals the seed amount", () => {
    const h = makeSeedHolding(
      "h1",
      "seed-h1",
      { symbol: "ETH", unitPrice: 3400, amount: 12 },
      1000,
    );
    expect(h.symbol).toBe("ETH");
    expect(h.unitPrice).toBe(3400);
    expect(holdingAmount(h)).toBe(12);
    // seed 是一条 occurredAt=now 的 set 活动
    expect(h.activities).toHaveLength(1);
    expect(h.activities[0]).toMatchObject({ kind: "set", amount: 12, occurredAt: 1000 });
  });
});

describe("mergedActivities", () => {
  it("flattens across holdings, annotates symbol, sorts occurredAt desc (createdAt desc tiebreak)", () => {
    const state = [
      holding("h1", "BTC", [act("a1", "set", 1, 100, 1), act("a2", "add", 0.5, 300, 2)]),
      holding("h2", "ETH", [act("b1", "add", 5, 200, 1), act("b2", "reduce", 1, 300, 5)]),
    ];
    const rows = mergedActivities(state);
    expect(rows.map((r) => r.id)).toEqual(["b2", "a2", "b1", "a1"]);
    expect(rows[0]).toMatchObject({ symbol: "ETH", holdingId: "h2" });
    expect(rows[2]).toMatchObject({ symbol: "ETH", holdingId: "h2" });
  });
});

describe("validateBatch", () => {
  const state = [holding("h1", "BTC", [act("a", "set", 1, 100)])];

  it("ok when reduces stay within running held", () => {
    const drafts: DraftActivity[] = [
      { holdingId: "h1", kind: "add", amount: 2, occurredAt: 200, createdAt: 0 },
      { holdingId: "h1", kind: "reduce", amount: 2.5, occurredAt: 300, createdAt: 1 },
    ];
    expect(validateBatch(state, drafts)).toEqual({ ok: true });
  });

  it("rejects the whole batch when a reduce overdraws at its point in time", () => {
    const drafts: DraftActivity[] = [
      { holdingId: "h1", kind: "reduce", amount: 5, occurredAt: 200, createdAt: 0 },
    ];
    expect(validateBatch(state, drafts)).toEqual({ ok: false, holdingId: "h1", symbol: "BTC" });
  });

  it("catches an existing reduce made invalid by an earlier-dated draft", () => {
    // 现有:set 5 @100, reduce 4 @300(合法,余 1)。插入 reduce 3 @200 → @300 时超支。
    const s = [holding("h1", "BTC", [act("a", "set", 5, 100), act("b", "reduce", 4, 300)])];
    const drafts: DraftActivity[] = [
      { holdingId: "h1", kind: "reduce", amount: 3, occurredAt: 200, createdAt: 0 },
    ];
    expect(validateBatch(s, drafts)).toEqual({ ok: false, holdingId: "h1", symbol: "BTC" });
  });
});

describe("commitBatch", () => {
  it("appends drafts as activities to their holdings", () => {
    const state = [holding("h1", "BTC", [act("a", "set", 1, 100)])];
    const drafts: DraftActivity[] = [
      { holdingId: "h1", kind: "add", amount: 2, occurredAt: 200, createdAt: 0, memo: "dca" },
    ];
    const next = commitBatch(state, drafts, (i) => `new-${i}`);
    expect(holdingAmount(next[0])).toBe(3);
    expect(next[0].activities.at(-1)).toMatchObject({ id: "new-0", kind: "add", memo: "dca" });
  });
});

describe("updateHolding", () => {
  const state = [
    makeSeedHolding("h1", "seed", { symbol: "BTC", unitPrice: 90000, amount: 2 }, 100),
  ];

  it("updates the definition without touching the ledger when amount is unchanged", () => {
    const next = updateHolding(
      state,
      "h1",
      { symbol: "BTC", unitPrice: 95000, amount: 2 },
      {
        id: "align",
        occurredAt: 500,
      },
    );
    expect(next[0].unitPrice).toBe(95000);
    expect(next[0].activities).toHaveLength(1); // 无对齐活动
    expect(holdingAmount(next[0])).toBe(2);
  });

  it("appends a set activity to align when amount changes", () => {
    const next = updateHolding(
      state,
      "h1",
      { symbol: "BTC", unitPrice: 90000, amount: 5 },
      {
        id: "align",
        occurredAt: 500,
      },
    );
    expect(next[0].activities).toHaveLength(2);
    expect(next[0].activities.at(-1)).toMatchObject({ id: "align", kind: "set", amount: 5 });
    expect(holdingAmount(next[0])).toBe(5);
  });
});

describe("findHolding", () => {
  const state = [
    { id: "h1", symbol: "BTC", unitPrice: 1, identifier: "bitcoin", activities: [] },
    { id: "h2", symbol: "ETH", unitPrice: 1, activities: [] }, // 无 identifier(手动录入)
  ];

  it("matches by identifier first", () => {
    expect(findHolding(state, { symbol: "XXX", identifier: "bitcoin", unitPrice: 1 })?.id).toBe(
      "h1",
    );
  });

  it("matches by symbol (case-insensitive) when the token has no identifier", () => {
    expect(findHolding(state, { symbol: "eth", unitPrice: 1 })?.id).toBe("h2");
  });

  it("returns undefined for an unheld token", () => {
    expect(
      findHolding(state, { symbol: "SOL", identifier: "solana", unitPrice: 1 }),
    ).toBeUndefined();
  });
});

describe("resolveActivityDrafts", () => {
  it("creates an empty holding for an unheld token and maps drafts to it", () => {
    const drafts: ActivityDraft[] = [
      {
        token: { symbol: "SOL", identifier: "solana", unitPrice: 150 },
        kind: "add",
        amount: 10,
        occurredAt: 100,
        createdAt: 0,
      },
    ];
    const { state, holdingDrafts } = resolveActivityDrafts([], drafts, (i) => `new-${i}`);
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ id: "new-0", symbol: "SOL", unitPrice: 150, activities: [] });
    expect(holdingDrafts[0].holdingId).toBe("new-0");
    // resolve 只建空 holding,活动入库交给 commitBatch
    const committed = commitBatch(state, holdingDrafts, (i) => `act-${i}`);
    expect(holdingAmount(committed[0])).toBe(10);
  });

  it("threads price/fee cost-basis metadata through to the stored activity", () => {
    const drafts: ActivityDraft[] = [
      {
        token: { symbol: "SOL", identifier: "solana", unitPrice: 150 },
        kind: "add",
        amount: 10,
        occurredAt: 100,
        createdAt: 0,
        price: 150.25,
        fee: 1.5,
      },
    ];
    const { state, holdingDrafts } = resolveActivityDrafts([], drafts, (i) => `new-${i}`);
    expect(holdingDrafts[0]).toMatchObject({ price: 150.25, fee: 1.5 });
    const committed = commitBatch(state, holdingDrafts, (i) => `act-${i}`);
    expect(committed[0].activities[0]).toMatchObject({ price: 150.25, fee: 1.5 });
    // price/fee 不影响数量折叠
    expect(holdingAmount(committed[0])).toBe(10);
  });

  it("reuses one created holding across multiple drafts for the same token", () => {
    const tok = { symbol: "SOL", identifier: "solana", unitPrice: 150 };
    const drafts: ActivityDraft[] = [
      { token: tok, kind: "add", amount: 10, occurredAt: 100, createdAt: 0 },
      { token: tok, kind: "add", amount: 5, occurredAt: 200, createdAt: 1 },
    ];
    const { state, holdingDrafts } = resolveActivityDrafts([], drafts, (i) => `new-${i}`);
    expect(state).toHaveLength(1);
    expect(holdingDrafts.map((d) => d.holdingId)).toEqual(["new-0", "new-0"]);
  });

  it("routes a draft to an existing holding without creating a new one", () => {
    const existing = [
      makeSeedHolding("h1", "s", { symbol: "BTC", unitPrice: 90000, amount: 1 }, 0),
    ];
    const drafts: ActivityDraft[] = [
      {
        token: { symbol: "BTC", identifier: undefined, unitPrice: 90000 },
        kind: "add",
        amount: 2,
        occurredAt: 300,
        createdAt: 0,
      },
    ];
    const { state, holdingDrafts } = resolveActivityDrafts(existing, drafts, (i) => `new-${i}`);
    expect(state).toHaveLength(1);
    expect(holdingDrafts[0].holdingId).toBe("h1");
  });
});

describe("updateActivity / holdingValid", () => {
  it("patches a single activity's fields, keeping id and createdAt", () => {
    const state = [holding("h1", "BTC", [act("a1", "add", 2, 100, 5)])];
    const next = updateActivity(state, "h1", "a1", { amount: 3, price: 65000, fee: 10 });
    expect(next[0].activities[0]).toMatchObject({
      id: "a1",
      kind: "add",
      amount: 3,
      createdAt: 5,
      price: 65000,
      fee: 10,
    });
    expect(holdingAmount(next[0])).toBe(3);
  });

  it("holdingValid catches an edit that overdraws the timeline", () => {
    // add 5 then reduce 3 → ok; edit the add down to 2 → reduce 3 now overdraws.
    const state = [
      holding("h1", "BTC", [act("a1", "add", 5, 100, 0), act("a2", "reduce", 3, 200, 1)]),
    ];
    expect(holdingValid(state, "h1")).toBe(true);
    const bad = updateActivity(state, "h1", "a1", { amount: 2 });
    expect(holdingValid(bad, "h1")).toBe(false);
  });
});

describe("addHolding / removeHolding / deleteActivity", () => {
  it("adds and removes holdings", () => {
    const h = makeSeedHolding("h1", "s", { symbol: "BTC", unitPrice: 1, amount: 1 }, 0);
    const added = addHolding([], h);
    expect(added).toHaveLength(1);
    expect(removeHolding(added, "h1")).toHaveLength(0);
  });

  it("deletes an activity and recomputes amount", () => {
    const state = [holding("h1", "BTC", [act("a", "set", 2, 100), act("b", "add", 3, 200)])];
    const next = deleteActivity(state, "h1", "b");
    expect(next[0].activities).toHaveLength(1);
    expect(holdingAmount(next[0])).toBe(2);
  });
});
