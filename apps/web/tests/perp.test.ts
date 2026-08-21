import { describe, expect, it } from "vitest";
import { toPerpView } from "@/lib/core/account-view";

// toPerpView 并存期同时吃两种形态(viewKind 归一):
//   · 遗留:kind="perp" + meta.role 判 equity/position(旧 provider 落库的历史行)
//   · 新:kind="perp_equity" / "perp_position"(迁移后的 connector 输出,meta 无 role)
// meta 经 zod safeParse:遗留的多余 role 键被 strip,故断言里不含 role。

// —— 遗留形态(kind=perp,meta 带 role) ——
const legacyEquity = {
  kind: "perp",
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
  amount: 0.0335,
  usdValue: 0,
  metaJson: JSON.stringify({
    role: "position",
    coin: "ETH",
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
  amount: -0.01,
  usdValue: 0,
  metaJson: JSON.stringify({
    role: "position",
    coin: "BTC",
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
    // 顺序按名义敞口降序(BTC 640 > ETH 100),不是入参顺序 —— 见下面那条专门的用例。
    expect(view.positions[0]).toMatchObject({
      coin: "BTC",
      size: -0.01,
      side: "short",
      liquidationPx: null,
    });
    expect(view.positions[1]).toMatchObject({ coin: "ETH", size: 0.0335, side: "long" });
  });

  // 以前不排:列表就是上游给的顺序(HL 给的是 BTC/ETH/SOL/AVAX… 一串没含义的顺序),看着像乱的。
  // 键取**名义敞口**是因为那正是仓位行右侧显示的那个数;按看不见的数排会比不排更像坏了。
  it("仓位按名义敞口降序(空仓取绝对值,不因为负号垫底)", () => {
    const view = toPerpView([legacyLong, legacyShort]);
    expect(view.positions.map((p) => p.coin)).toEqual(["BTC", "ETH"]);
  });

  it("只有 equity、无持仓的账户", () => {
    const view = toPerpView([legacyEquity]);
    expect(view.equity?.accountValue).toBe(13109.482328);
    expect(view.positions).toEqual([]);
  });

  it("坏/缺 metaJson 的行被忽略(不抛)", () => {
    const view = toPerpView([
      { kind: "perp", amount: 1, usdValue: 0, metaJson: null },
      { kind: "perp", amount: 1, usdValue: 0, metaJson: "not json" },
      {
        kind: "perp",
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
  it("多个权益行(如 Binance U 本位 + 币本位)→ 累加合并成一个账户权益,不互相覆盖", () => {
    const view = toPerpView([
      {
        kind: "perp_equity",
        amount: 1000,
        usdValue: 1000,
        metaJson: JSON.stringify({ withdrawable: 800, totalMarginUsed: 200, totalNtlPos: 3000 }),
      },
      {
        kind: "perp_equity",
        amount: 500,
        usdValue: 500,
        metaJson: JSON.stringify({ withdrawable: 400, totalMarginUsed: 100, totalNtlPos: 2000 }),
      },
    ]);
    expect(view.equity).toEqual({
      accountValue: 1500,
      withdrawable: 1200,
      totalMarginUsed: 300,
      totalNtlPos: 5000,
    });
  });

  it("按 kind 判别拆 equity/positions", () => {
    const view = toPerpView([
      {
        kind: "perp_equity",
        amount: 1000,
        usdValue: 1000,
        metaJson: JSON.stringify({ withdrawable: 900, totalMarginUsed: 100, totalNtlPos: 5000 }),
      },
      {
        kind: "perp_position",
        amount: 0.5,
        usdValue: 0,
        metaJson: JSON.stringify({
          coin: "BTC",
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

import { liqRisk, markPx, pnlPct } from "@/routes/_authed/-home/holdings/perp/liq-risk";

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

describe("liqRisk —— 安全余量 d = |标记−强平| / 标记(距强平占现价%)+ 三态", () => {
  it("强平远在现价 15% 外 → safe;fill 封顶为满环", () => {
    // long:mark 3380、liq 2140 → d = 1240/3380 ≈ 0.367(> 25% 上限 → 满环)
    const r = liqRisk(pos({}));
    expect(r?.state).toBe("safe");
    expect(r?.distance).toBeCloseTo(0.367, 2);
    expect(r?.fill).toBe(1);
  });
  it("距强平 5%~15% → warn(空头方向同样成立)", () => {
    // short:mark 66500、liq 71500 → d = 5000/66500 ≈ 0.075
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
    expect(r?.distance).toBeCloseTo(0.075, 3);
    expect(r?.fill).toBeCloseTo(0.301, 2); // 0.075 / 0.25
  });
  it("距强平 < 5% → danger", () => {
    // long:mark 98、liq 95 → d = 3/98 ≈ 0.031
    const r = liqRisk(pos({ size: 1, entryPx: 100, positionValue: 98, liquidationPx: 95 }));
    expect(r?.state).toBe("danger");
    expect(r?.distance).toBeCloseTo(0.031, 3);
  });
  it("标记越过强平另一侧(穿仓/脏快照)→ d clamp 0 → danger,而非误报安全", () => {
    // long:liq 80、mark 60(已穿仓)——无方向感知会得正距离(误 safe)。
    const r = liqRisk(pos({ size: 1, entryPx: 100, positionValue: 60, liquidationPx: 80 }));
    expect(r?.state).toBe("danger");
    expect(r?.distance).toBe(0);
    expect(r?.fill).toBe(0);
  });
  it("richer 返回:携带 mark 与非空 liquidationPx(消费端不再重推)", () => {
    const r = liqRisk(pos({}));
    expect(r?.mark).toBeCloseTo(3380);
    expect(r?.liquidationPx).toBe(2140);
  });
  it("liquidationPx null / 开仓=强平 / size 0 / mark≤0 → null(UI 降级为文本)", () => {
    expect(liqRisk(pos({ liquidationPx: null }))).toBeNull();
    expect(liqRisk(pos({ entryPx: 2140 }))).toBeNull();
    expect(liqRisk(pos({ size: 0 }))).toBeNull();
    expect(liqRisk(pos({ positionValue: 0 }))).toBeNull(); // mark = 0 → null
  });
});
