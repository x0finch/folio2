import { describe, expect, it } from "vitest";
import { hasStaleHoldings } from "../src/lib/account-stale";

// 缺凭据账户可能带导入快照(import 会写 snapshot)→ 有陈旧持仓;也可能无快照 → 空态。
// 判定:有快照时刻 且 有持仓行 → 显示陈旧持仓 + "N 天前"标注;否则显示空态占位。
describe("hasStaleHoldings", () => {
  it("true when there is a snapshot time and at least one balance", () => {
    expect(hasStaleHoldings({ takenAt: 1_700_000_000_000, balances: [{ symbol: "BTC" }] })).toBe(
      true,
    );
  });

  it("false when never synced (no snapshot time)", () => {
    expect(hasStaleHoldings({ takenAt: null, balances: [{ symbol: "BTC" }] })).toBe(false);
  });

  it("false when a snapshot exists but holds nothing", () => {
    expect(hasStaleHoldings({ takenAt: 1_700_000_000_000, balances: [] })).toBe(false);
  });
});
