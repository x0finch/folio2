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

// —— v2 展示推导(H5 #120):标记价 / 盈亏% / 强平风险 ——
// 全部纯推导自 PerpPositionView 既有字段,除零/缺失一律返回 null(UI 降级)。

import { liqRisk, markPx, pnlPct } from "../src/lib/perp";

const pos = (over: Partial<Parameters<typeof markPx>[0]>): Parameters<typeof markPx>[0] => ({
  coin: "ETH",
  size: 12,
  side: "long",
  entryPx: 3180,
  positionValue: 40560,
  unrealizedPnl: 2400,
  liquidationPx: 2140,
  marginUsed: 13520,
  ...over,
});

describe("markPx —— 标记价 = positionValue / |size|", () => {
  it("多头", () => {
    expect(markPx(pos({}))).toBeCloseTo(3380);
  });
  it("空头(size 为负,取绝对值)", () => {
    expect(markPx(pos({ size: -0.5, positionValue: 33250 }))).toBeCloseTo(66500);
  });
  it("size 为 0 → null", () => {
    expect(markPx(pos({ size: 0 }))).toBeNull();
  });
});

describe("pnlPct —— uPnL% 相对开仓名义值(百分数)", () => {
  it("盈利多头:2400 / (12×3180)", () => {
    expect(pnlPct(pos({}))).toBeCloseTo(6.289, 2);
  });
  it("亏损为负", () => {
    expect(pnlPct(pos({ unrealizedPnl: -3000 }))).toBeCloseTo(-7.86, 2);
  });
  it("entryPx 或 size 为 0 → null", () => {
    expect(pnlPct(pos({ entryPx: 0 }))).toBeNull();
    expect(pnlPct(pos({ size: 0 }))).toBeNull();
  });
});

describe("liqRisk —— 安全余量 d = |标记−强平| / |开仓−强平| + 三态", () => {
  it("标记比开仓离强平更远 → d≥1 → safe", () => {
    const r = liqRisk(pos({}));
    expect(r?.state).toBe("safe");
    expect(r?.margin).toBeGreaterThanOrEqual(1);
  });
  it("余量过半 → warn(空头方向同样成立)", () => {
    // short:entry 62000、liq 71500、mark 66500 → d = 5000/9500 ≈ 0.53
    const r = liqRisk(
      pos({
        side: "short",
        size: -0.5,
        entryPx: 62000,
        positionValue: 33250,
        liquidationPx: 71500,
      }),
    );
    expect(r?.state).toBe("warn");
    expect(r?.margin).toBeCloseTo(0.526, 2);
  });
  it("余量不足一半 → danger", () => {
    // long:entry 155、liq 128、mark 140 → d = 12/27 ≈ 0.44
    const r = liqRisk(pos({ size: 200, entryPx: 155, positionValue: 28000, liquidationPx: 128 }));
    expect(r?.state).toBe("danger");
  });
  it("liquidationPx null / 开仓=强平 / size 0 → null(UI 降级为文本)", () => {
    expect(liqRisk(pos({ liquidationPx: null }))).toBeNull();
    expect(liqRisk(pos({ entryPx: 2140 }))).toBeNull();
    expect(liqRisk(pos({ size: 0 }))).toBeNull();
  });
});
