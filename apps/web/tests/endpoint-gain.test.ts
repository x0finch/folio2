import { describe, expect, it } from "vitest";
import { endpointGain } from "@/lib/core/portfolio";

// 24h P&L = value now − value 24h ago; pct = diff ÷ start (start ≤ 0 → null). A missing start means no
// observation → null (UI `—`), which must differ from { amount: 0 } (computable, flat).
describe("endpointGain — endpoint subtraction", () => {
  it("up / down: amount = diff, percent relative to the start", () => {
    expect(endpointGain(100, 130)).toEqual({ amount: 30, pct: 30 });
    expect(endpointGain(200, 150)).toEqual({ amount: -50, pct: -25 });
  });

  it("missing start (account under 24h old / offline over 7 days) → null, not 0", () => {
    expect(endpointGain(null, 130)).toBeNull();
    expect(endpointGain(undefined, 130)).toBeNull();
  });

  it("computable but flat → { amount: 0, pct: 0 }, distinct from not computable", () => {
    expect(endpointGain(100, 100)).toEqual({ amount: 0, pct: 0 });
  });

  it("start 0 (bought / deposited today) → amount given, percent null (zero denominator)", () => {
    expect(endpointGain(0, 130)).toEqual({ amount: 130, pct: null });
  });

  it("negative start (DeFi net debt) → percent null, amount given", () => {
    expect(endpointGain(-50, -20)).toEqual({ amount: 30, pct: null });
  });
});
