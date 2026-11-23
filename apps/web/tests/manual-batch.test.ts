import { describe, expect, it } from "vitest";
import type { DerivableActivity } from "@/lib/core/manual";
import {
  findToken,
  planManualBatch,
  type ResolvedDraft,
  runningOk,
  type Token,
} from "@/lib/server/manual/batch";

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
  activities: [],
  ...o,
});

describe("runningOk", () => {
  it("reduce never overdraws -> ok", () => {
    expect(
      runningOk([
        act({ kind: "set", amount: 5, occurredAt: 1 }),
        act({ kind: "reduce", amount: 3, occurredAt: 2 }),
      ]),
    ).toBe(true);
  });

  it("reduce exceeds the running holding at its time -> not ok", () => {
    expect(
      runningOk([
        act({ kind: "set", amount: 2, occurredAt: 1 }),
        act({ kind: "reduce", amount: 3, occurredAt: 2 }),
      ]),
    ).toBe(false);
  });

  it("ordered by occurredAt then createdAt (a backdated entry can push later reduces under)", () => {
    // set 5 @t3, reduce 5 @t4 is valid; but backdating reduce 4 @t2 (baseline 0) overdraws there.
    expect(
      runningOk([
        act({ kind: "set", amount: 5, occurredAt: 3 }),
        act({ kind: "reduce", amount: 5, occurredAt: 4 }),
        act({ kind: "reduce", amount: 4, occurredAt: 2 }),
      ]),
    ).toBe(false);
  });
});

// Token identity is resolved upstream by mint; this only compares ids. A second symbol-based
// heuristic here would drift from mint and give two answers.
describe("findToken (compares mint-issued ids only)", () => {
  const tokens = [mkToken({ id: "a", symbol: "BTC" }), mkToken({ id: "b", symbol: "ETH" })];

  it("matches by tokenId", () => {
    expect(findToken(tokens, { tokenId: "b", symbol: "ETH", unitPrice: 1 })?.id).toBe("b");
  });

  // Same symbol but mint says two tokens (e.g. a copycat contract) -> never merge.
  it("same symbol, different id -> no match", () => {
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

  it("matches an existing holding -> activity only, no duplicate declaration", () => {
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

  it("not yet held by this account -> declares one, using the mint-issued id", () => {
    const plan = planManualBatch([], [draft({ amount: 3 })]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // The declaration carries only symbol; price lives on the activity (the ledger is its only source).
    expect(plan.declare).toEqual([{ id: "tk_btc", symbol: "BTC" }]);
    expect(plan.activities[0].tokenId).toBe("tk_btc");
  });

  it("multiple drafts for the same token in one batch -> declared once", () => {
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

  it("rejects the whole batch: any reduce over the running holding (including pushed-under existing reduces)", () => {
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
    // Backdated reduce 4 @50 (baseline 0) overdraws this token's timeline -> whole batch rejected.
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

  it("a new draft at the same occurredAt sorts after existing ones (no false overdraw)", () => {
    const existing = [
      mkToken({
        id: "tk_btc",
        symbol: "BTC",
        activities: [{ kind: "set", amount: 1, occurredAt: 10, createdAt: 1 }],
      }),
    ];
    // Appending reduce 1 at occurredAt=10 sorts after the existing set 1 -> holding 0, valid.
    const plan = planManualBatch(existing, [draft({ kind: "reduce", amount: 1, occurredAt: 10 })]);
    expect(plan.ok).toBe(true);
  });
});
