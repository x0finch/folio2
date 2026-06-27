import { describe, expect, it } from "vitest";
import { toPerpView } from "../src/lib/perp";

// 模拟 getMyOverview 返回的余额行(metaJson = 落库 JSON 字符串,toPerpView 内部解析)。
const equityRow = {
  symbol: "USDC",
  amount: 13109.482328,
  usdValue: 13109.482328,
  metaJson: JSON.stringify({
    role: "equity",
    withdrawable: 13104.5,
    totalMarginUsed: 4.97,
    totalNtlPos: 100,
  }),
};
const longRow = {
  symbol: "ETH",
  amount: 0.0335,
  usdValue: 0,
  metaJson: JSON.stringify({
    role: "position",
    side: "long",
    entryPx: 2986.3,
    positionValue: 100,
    unrealizedPnl: -0.01,
    leverage: 20,
    leverageType: "isolated",
    liquidationPx: 2866.27,
    marginUsed: 4.97,
  }),
};
const shortRow = {
  symbol: "BTC",
  amount: -0.01,
  usdValue: 0,
  metaJson: JSON.stringify({
    role: "position",
    side: "short",
    entryPx: 64000,
    positionValue: 640,
    unrealizedPnl: 12.5,
    leverage: 10,
    leverageType: "cross",
    liquidationPx: null,
    marginUsed: 64,
  }),
};

describe("toPerpView", () => {
  it("splits equity (with accountValue) from positions (coin/size merged in)", () => {
    const view = toPerpView([equityRow, longRow, shortRow]);
    expect(view.equity).toMatchObject({
      role: "equity",
      accountValue: 13109.482328,
      withdrawable: 13104.5,
    });
    expect(view.positions).toHaveLength(2);
    expect(view.positions[0]).toMatchObject({ coin: "ETH", size: 0.0335, side: "long" });
    expect(view.positions[1]).toMatchObject({
      coin: "BTC",
      size: -0.01,
      side: "short",
      liquidationPx: null,
    });
  });

  it("returns equity only for an account with no open positions", () => {
    const view = toPerpView([equityRow]);
    expect(view.equity?.accountValue).toBe(13109.482328);
    expect(view.positions).toEqual([]);
  });

  it("ignores rows with missing/invalid metaJson (no throw)", () => {
    const view = toPerpView([
      { symbol: "X", amount: 1, usdValue: 0, metaJson: null },
      { symbol: "Y", amount: 1, usdValue: 0, metaJson: "not json" },
      { symbol: "Z", amount: 1, usdValue: 0, metaJson: JSON.stringify({ role: "weird" }) },
      longRow,
    ]);
    expect(view.equity).toBeNull();
    expect(view.positions).toHaveLength(1);
    expect(view.positions[0].coin).toBe("ETH");
  });
});
