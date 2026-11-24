import { describe, expect, it } from "vitest";
import { toPerpView } from "@/lib/core/account-view";

// toPerpView accepts both shapes (normalized via viewKind): legacy kind="perp" + meta.role, and
// kind="perp_equity" / "perp_position". meta goes through zod safeParse, which strips legacy role.

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

describe("toPerpView — legacy kind=perp (via meta.role)", () => {
  it("splits equity (with accountValue) and positions (coin/size merged in)", () => {
    const view = toPerpView([legacyEquity, legacyLong, legacyShort]);
    expect(view.equity).toMatchObject({ accountValue: 13109.482328, withdrawable: 13104.5 });
    expect(view.positions).toHaveLength(2);
    // Ordered by notional descending (BTC 640 > ETH 100), not input order.
    expect(view.positions[0]).toMatchObject({
      coin: "BTC",
      size: -0.01,
      side: "short",
      liquidationPx: null,
    });
    expect(view.positions[1]).toMatchObject({ coin: "ETH", size: 0.0335, side: "long" });
  });

  // Sort key is notional because that is the number shown on the row; sorting by a hidden number
  // looks more broken than not sorting.
  it("positions sorted by notional descending (shorts by absolute value, not sunk by the sign)", () => {
    const view = toPerpView([legacyLong, legacyShort]);
    expect(view.positions.map((p) => p.coin)).toEqual(["BTC", "ETH"]);
  });

  it("account with equity only, no positions", () => {
    const view = toPerpView([legacyEquity]);
    expect(view.equity?.accountValue).toBe(13109.482328);
    expect(view.positions).toEqual([]);
  });

  it("bad/missing metaJson rows are ignored (no throw)", () => {
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

describe("toPerpView — kind=perp_equity/perp_position (no role in meta)", () => {
  it("multiple equity rows (e.g. Binance USD-M + COIN-M) -> summed into one equity, not overwritten", () => {
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

  it("splits equity/positions by kind", () => {
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

// Display derivations (mark price / pnl% / liquidation risk) from PerpPositionView fields;
// divide-by-zero or missing input returns null (UI degrades).

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

describe("markPx — mark price = positionValue / |size|", () => {
  it("long", () => {
    expect(markPx(pos({}))).toBeCloseTo(3380);
  });
  it("short (negative size, absolute value)", () => {
    expect(markPx(pos({ size: -0.5, positionValue: 33250 }))).toBeCloseTo(66500);
  });
  it("size 0 -> null", () => {
    expect(markPx(pos({ size: 0 }))).toBeNull();
  });
});

describe("pnlPct — uPnL% relative to entry notional (percent)", () => {
  it("profitable long: 2400 / (12x3180)", () => {
    expect(pnlPct(pos({}))).toBeCloseTo(6.289, 2);
  });
  it("a loss is negative", () => {
    expect(pnlPct(pos({ unrealizedPnl: -3000 }))).toBeCloseTo(-7.86, 2);
  });
  it("entryPx or size 0 -> null", () => {
    expect(pnlPct(pos({ entryPx: 0 }))).toBeNull();
    expect(pnlPct(pos({ size: 0 }))).toBeNull();
  });
});

describe("liqRisk — safety buffer d = |mark - liq| / mark, plus three states", () => {
  it("liquidation beyond 15% from price -> safe; fill caps at a full ring", () => {
    // long: mark 3380, liq 2140 -> d = 1240/3380 ~ 0.367 (above the 25% cap -> full ring)
    const r = liqRisk(pos({}));
    expect(r?.state).toBe("safe");
    expect(r?.distance).toBeCloseTo(0.367, 2);
    expect(r?.fill).toBe(1);
  });
  it("5%-15% from liquidation -> warn (holds for shorts too)", () => {
    // short: mark 66500, liq 71500 -> d = 5000/66500 ~ 0.075
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
  it("under 5% from liquidation -> danger", () => {
    // long: mark 98, liq 95 -> d = 3/98 ~ 0.031
    const r = liqRisk(pos({ size: 1, entryPx: 100, positionValue: 98, liquidationPx: 95 }));
    expect(r?.state).toBe("danger");
    expect(r?.distance).toBeCloseTo(0.031, 3);
  });
  it("mark past liquidation (underwater / dirty snapshot) -> d clamps to 0 -> danger, not falsely safe", () => {
    // long: liq 80, mark 60 (underwater); a direction-blind distance would read safe.
    const r = liqRisk(pos({ size: 1, entryPx: 100, positionValue: 60, liquidationPx: 80 }));
    expect(r?.state).toBe("danger");
    expect(r?.distance).toBe(0);
    expect(r?.fill).toBe(0);
  });
  it("richer return: carries mark and non-null liquidationPx (consumers do not re-derive)", () => {
    const r = liqRisk(pos({}));
    expect(r?.mark).toBeCloseTo(3380);
    expect(r?.liquidationPx).toBe(2140);
  });
  it("liquidationPx null / entry = liq / size 0 / mark <= 0 -> null (UI falls back to text)", () => {
    expect(liqRisk(pos({ liquidationPx: null }))).toBeNull();
    expect(liqRisk(pos({ entryPx: 2140 }))).toBeNull();
    expect(liqRisk(pos({ size: 0 }))).toBeNull();
    expect(liqRisk(pos({ positionValue: 0 }))).toBeNull(); // mark = 0 → null
  });
});
