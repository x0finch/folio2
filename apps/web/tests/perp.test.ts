import { describe, expect, it } from "vitest";
import { toPerpView } from "../src/lib/perp";

// toPerpView 并存期同时吃两种形态(viewKind 归一):
//   · 遗留:kind="perp" + meta.role 判 equity/position(旧 provider 落库的历史行)
//   · 新:kind="perp_equity" / "perp_position"(迁移后的 connector 输出,meta 无 role)
// meta 经 zod safeParse:遗留的多余 role 键被 strip,故断言里不含 role。

// —— 遗留形态(kind=perp,meta 带 role) ——
const legacyEquity = {
  kind: "perp",
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
const legacyLong = {
  kind: "perp",
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
const legacyShort = {
  kind: "perp",
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

describe("toPerpView —— 遗留 kind=perp(靠 meta.role)", () => {
  it("拆 equity(带 accountValue)与 positions(coin/size 并入)", () => {
    const view = toPerpView([legacyEquity, legacyLong, legacyShort]);
    expect(view.equity).toMatchObject({ accountValue: 13109.482328, withdrawable: 13104.5 });
    expect(view.positions).toHaveLength(2);
    expect(view.positions[0]).toMatchObject({ coin: "ETH", size: 0.0335, side: "long" });
    expect(view.positions[1]).toMatchObject({
      coin: "BTC",
      size: -0.01,
      side: "short",
      liquidationPx: null,
    });
  });

  it("只有 equity、无持仓的账户", () => {
    const view = toPerpView([legacyEquity]);
    expect(view.equity?.accountValue).toBe(13109.482328);
    expect(view.positions).toEqual([]);
  });

  it("坏/缺 metaJson 的行被忽略(不抛)", () => {
    const view = toPerpView([
      { kind: "perp", symbol: "X", amount: 1, usdValue: 0, metaJson: null },
      { kind: "perp", symbol: "Y", amount: 1, usdValue: 0, metaJson: "not json" },
      {
        kind: "perp",
        symbol: "Z",
        amount: 1,
        usdValue: 0,
        metaJson: JSON.stringify({ role: "weird" }),
      },
      legacyLong,
    ]);
    expect(view.equity).toBeNull();
    expect(view.positions).toHaveLength(1);
    expect(view.positions[0].coin).toBe("ETH");
  });
});

describe("toPerpView —— 新 kind=perp_equity/perp_position(meta 无 role)", () => {
  it("按 kind 判别拆 equity/positions", () => {
    const view = toPerpView([
      {
        kind: "perp_equity",
        symbol: "USDC",
        amount: 1000,
        usdValue: 1000,
        metaJson: JSON.stringify({ withdrawable: 900, totalMarginUsed: 100, totalNtlPos: 5000 }),
      },
      {
        kind: "perp_position",
        symbol: "BTC",
        amount: 0.5,
        usdValue: 0,
        metaJson: JSON.stringify({
          side: "long",
          entryPx: 60000,
          positionValue: 30000,
          unrealizedPnl: 500,
          liquidationPx: 45000,
          marginUsed: 3000,
        }),
      },
    ]);
    expect(view.equity).toMatchObject({ accountValue: 1000, withdrawable: 900 });
    expect(view.positions).toHaveLength(1);
    expect(view.positions[0]).toMatchObject({ coin: "BTC", size: 0.5, side: "long" });
  });
});
