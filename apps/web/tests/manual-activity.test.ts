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

  it("每步夹 0:中途超卖归零、不产生负债带到后续(删除更早开仓后的场景)", () => {
    // add1 → reduce2(超卖,归 0)→ add1 ⇒ 1;而非末值夹 0 的 (1−2+1)=0。
    // 即用户删掉开仓 set 后剩 add1/reduce2/add1 的原景。
    expect(deriveAmount([a("add", 1, 1), a("reduce", 2, 2), a("add", 1, 3)])).toBe(1);
  });

  it("超卖归零后再买入从 0 起算(不倒扣)", () => {
    expect(deriveAmount([a("set", 10, 1), a("reduce", 15, 2), a("add", 3, 3)])).toBe(3);
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
    expect(t).toEqual({ symbol: "BTC", unitPrice: 64000, amount: 1.5, ref: null });
  });

  // ref 原样搬运 —— 本模块不看里面写了什么(命名者是谁、id 长什么样都不是它的事)。
  it("carries the ref through untouched", () => {
    const t = projectToken({ symbol: "BTC", unitPrice: 64000, ref: "src/issued:bitcoin" }, [
      a("set", 2, 1),
    ]);
    expect(t).toEqual({ symbol: "BTC", unitPrice: 64000, amount: 2, ref: "src/issued:bitcoin" });
  });

  it("no ref (that namer hasn't identified it) → null, never undefined", () => {
    const t = projectToken({ symbol: "FOO", unitPrice: 0.25, ref: null }, []);
    expect(t).toEqual({ symbol: "FOO", unitPrice: 0.25, amount: 0, ref: null });
  });
});
