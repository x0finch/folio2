import { describe, expect, it } from "vitest";
import { dayValueChange } from "../src/lib/day-value-change";

describe("dayValueChange", () => {
  it("涨:增值 = 市值 − 市值/(1+pct/100)", () => {
    // +25% → 前值 = 125/1.25 = 100,增值 = 25
    expect(dayValueChange(125, 25)).toBeCloseTo(25, 6);
  });

  it("跌:增值为负", () => {
    // −20% → 前值 = 80/0.8 = 100,增值 = −20
    expect(dayValueChange(80, -20)).toBeCloseTo(-20, 6);
  });

  it("无 change24h / 恰好 0 → null(不显示)", () => {
    expect(dayValueChange(100, undefined)).toBeNull();
    expect(dayValueChange(100, 0)).toBeNull();
  });

  it("前值不合法(≤ −100%,factor ≤ 0)→ null", () => {
    expect(dayValueChange(100, -100)).toBeNull();
    expect(dayValueChange(100, -150)).toBeNull();
  });
});
