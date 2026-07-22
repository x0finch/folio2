import { describe, expect, it } from "vitest";
import { type DerivableActivity, deriveAmount, projectToken } from "../src/lib/manual-activity";

const a = (
  kind: DerivableActivity["kind"],
  amount: number,
  occurredAt: number,
  createdAt = 0,
): DerivableActivity => ({ kind, amount, occurredAt, createdAt });

describe("deriveAmount", () => {
  it("empty → 0", () => {
    expect(deriveAmount([])).toBe(0);
  });

  it("no set → baseline 0 + deltas", () => {
    expect(deriveAmount([a("add", 5, 1), a("add", 3, 2), a("reduce", 2, 3)])).toBe(6);
  });

  it("set resets baseline (prior activity ignored), then deltas apply", () => {
    expect(deriveAmount([a("add", 5, 1), a("set", 10, 2), a("add", 2, 3)])).toBe(12);
  });

  it("last set wins among multiple sets", () => {
    expect(deriveAmount([a("set", 10, 1), a("add", 5, 2), a("set", 3, 3)])).toBe(3);
  });

  it("clamps at 0 (reduce more than held)", () => {
    expect(deriveAmount([a("add", 5, 1), a("reduce", 10, 2)])).toBe(0);
  });

  it("orders by occurredAt then createdAt (insertion order tiebreak)", () => {
    // same occurredAt: set(createdAt 1) then add(createdAt 2) → 10 + 1 = 11
    expect(deriveAmount([a("add", 1, 5, 2), a("set", 10, 5, 1)])).toBe(11);
  });
});

// projectToken:token 定义 + 活动账本 → creds.tokens 的一项(物化投影,ADR 0017)。
describe("projectToken", () => {
  it("amount = deriveAmount(activities); carries symbol/unitPrice", () => {
    const t = projectToken({ symbol: "BTC", unitPrice: 64000 }, [a("set", 1, 1), a("add", 0.5, 2)]);
    expect(t).toEqual({ symbol: "BTC", unitPrice: 64000, amount: 1.5 });
  });

  it("includes identifier when present", () => {
    const t = projectToken({ symbol: "BTC", unitPrice: 64000, identifier: "bitcoin" }, [
      a("set", 2, 1),
    ]);
    expect(t).toEqual({ symbol: "BTC", unitPrice: 64000, amount: 2, identifier: "bitcoin" });
  });

  it("omits identifier key when null/absent (provider validator treats it as optional string)", () => {
    const t = projectToken({ symbol: "FOO", unitPrice: 0.25, identifier: null }, []);
    expect(t).toEqual({ symbol: "FOO", unitPrice: 0.25, amount: 0 });
    expect("identifier" in t).toBe(false);
  });
});
