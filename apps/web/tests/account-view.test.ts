import { describe, expect, it } from "vitest";
import { type OverviewBalance, toAccountSections } from "../src/lib/account-view";

const b = (over: Partial<OverviewBalance>): OverviewBalance => ({
  id: "x",
  symbol: "X",
  amount: 1,
  usdValue: 0,
  kind: "spot",
  metaJson: null,
  ...over,
});

describe("toAccountSections", () => {
  it("puts spot and manual rows in the spot table", () => {
    const s = toAccountSections([
      b({ id: "1", symbol: "ETH", usdValue: 5000, kind: "spot" }),
      b({ id: "2", symbol: "CASH", usdValue: 100, kind: "manual" }),
    ]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["ETH", "CASH"]);
    expect(s.defi).toEqual([]);
    expect(s.perp).toBeNull();
  });

  it("过滤掉价值显示为 $0.00 的零值现货(无价/空投尘埃)", () => {
    const s = toAccountSections([
      b({ id: "1", symbol: "ETH", usdValue: 5000, kind: "spot" }),
      b({ id: "2", symbol: "SPAM", usdValue: 0, kind: "spot" }), // 无价 → 排除
      b({ id: "3", symbol: "DUST", usdValue: 0.004, kind: "spot" }), // 显示 $0.00 → 排除
    ]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["ETH"]);
  });

  it("balance 级 note(单个 Note)透传到 SpotRow.note(note 重设计)", () => {
    const note = {
      title: "Locked",
      icon: "warning" as const,
      content: [{ label: "ETH", value: 1, unit: "ETH" }],
    };
    const s = toAccountSections([
      b({ id: "1", symbol: "ETH", usdValue: 5000, kind: "spot", note }),
      b({ id: "2", symbol: "BTC", usdValue: 100, kind: "spot" }), // 无 note 的行
    ]);
    expect(s.spot.find((r) => r.symbol === "ETH")?.note).toEqual(note);
    expect(s.spot.find((r) => r.symbol === "BTC")?.note).toBeUndefined();
  });

  it("groups defi rows by protocol (preserving first-seen order, with fallback)", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "aUSDC",
        kind: "defi",
        usdValue: 2000,
        metaJson: JSON.stringify({ protocol: "Aave", positionType: "deposit" }),
      }),
      b({
        id: "2",
        symbol: "UNI-LP",
        kind: "defi",
        usdValue: 5000,
        metaJson: JSON.stringify({ protocol: "Uniswap", positionType: "lp" }),
      }),
      b({
        id: "3",
        symbol: "aETH",
        kind: "defi",
        usdValue: -2500,
        metaJson: JSON.stringify({ protocol: "Aave", positionType: "loan" }),
      }),
      b({ id: "4", symbol: "MYST", kind: "defi", usdValue: 10, metaJson: null }), // 无 protocol → fallback
    ]);
    expect(s.defi.map((g) => g.protocol)).toEqual(["Aave", "Uniswap", "Other"]);
    const aave = s.defi[0];
    expect(aave.rows.map((r) => r.symbol)).toEqual(["aUSDC", "aETH"]);
    expect(aave.rows[1].usdValue).toBe(-2500); // 负债保留
    expect(aave.rows[0].positionType).toBe("deposit");
  });

  it("routes perp rows through toPerpView", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "USDC",
        kind: "perp",
        usdValue: 13109,
        metaJson: JSON.stringify({
          role: "equity",
          withdrawable: 13000,
          totalMarginUsed: 5,
          totalNtlPos: 100,
        }),
      }),
      b({
        id: "2",
        symbol: "ETH",
        kind: "perp",
        usdValue: 0,
        metaJson: JSON.stringify({
          role: "position",
          coin: "ETH",
          side: "long",
          entryPx: 2986,
          positionValue: 100,
          unrealizedPnl: -1,
          liquidationPx: null,
          marginUsed: 5,
        }),
      }),
    ]);
    expect(s.perp?.equity?.accountValue).toBe(13109);
    expect(s.perp?.positions).toHaveLength(1);
    expect(s.spot).toEqual([]);
  });

  it("handles an empty account", () => {
    expect(toAccountSections([])).toEqual({
      spot: [],
      defi: [],
      perp: null,
    });
  });

  // BTC(utxo/spot 口径)仍进现货表;展示明细(未确认/派生/收款)已提到账户级 note(note 重设计),
  // 不再由 toAccountSections 从 per-balance meta 抽出。
  it("BTC 行进现货表(spot 口径)", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "BTC",
        kind: "spot",
        usdValue: 5000,
        tokenRef: "bitcoin/native",
        metaJson: JSON.stringify({ pendingSats: 500000 }),
      }),
    ]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["BTC"]);
  });

  it("遗留 kind=utxo 老化归现货表(ADR 0010:utxo 并回 spot,viewKind default 兜底)", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "BTC",
        kind: "utxo", // 旧快照遗留 kind;viewKind 经 default 归 spot
        usdValue: 5000,
        tokenRef: "bitcoin/native",
        metaJson: JSON.stringify({ pendingSats: 12345 }),
      }),
    ]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["BTC"]);
  });

  it("新 kind=perp_equity/perp_position:走 perp 视图", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "USDC",
        kind: "perp_equity",
        usdValue: 1000,
        metaJson: JSON.stringify({ withdrawable: 900, totalMarginUsed: 100, totalNtlPos: 5000 }),
      }),
      b({
        id: "2",
        symbol: "BTC",
        kind: "perp_position",
        usdValue: 0,
        metaJson: JSON.stringify({
          coin: "BTC",
          side: "short",
          entryPx: 64000,
          positionValue: 640,
          unrealizedPnl: 12.5,
          liquidationPx: null,
          marginUsed: 64,
        }),
      }),
    ]);
    expect(s.perp?.equity?.accountValue).toBe(1000);
    expect(s.perp?.positions).toHaveLength(1);
    expect(s.perp?.positions[0].side).toBe("short");
    expect(s.spot).toEqual([]);
  });

  it("未知 kind 兜底为现货(不 throw)", () => {
    const s = toAccountSections([b({ id: "1", symbol: "???", kind: "mystery", usdValue: 1 })]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["???"]);
  });
});

// —— H5 #120:DeFi 行 change24h 透传 + 跨账户协议合并 + 协议级 24h 聚合 ——

import { mergeDefiGroups, protocolDayChange } from "../src/lib/account-view";

describe("DefiRow change24h 透传(富化字段,缺则 undefined)", () => {
  it("带 change24h 的 defi 行透传到 DefiRow", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "stETH",
        kind: "defi",
        usdValue: 27040,
        change24h: 2.1,
        metaJson: JSON.stringify({ protocol: "Lido", positionType: "staked" }),
      }),
    ]);
    expect(s.defi[0].rows[0].change24h).toBe(2.1);
  });
});

describe("mergeDefiGroups —— 跨账户按协议保序合并", () => {
  const g = (protocol: string, id: string, usdValue = 1) => ({
    protocol,
    rows: [{ id, symbol: "X", amount: 1, usdValue }],
  });
  it("同协议行并入首次出现的组,组序按首见", () => {
    const merged = mergeDefiGroups([
      { defi: [g("Aave", "a1"), g("Lido", "l1")] },
      { defi: [g("Aave", "a2")] },
      { defi: [] },
    ]);
    expect(merged.map((x) => x.protocol)).toEqual(["Aave", "Lido"]);
    expect(merged[0].rows.map((r) => r.id)).toEqual(["a1", "a2"]);
  });
  it("全空 → []", () => {
    expect(mergeDefiGroups([{ defi: [] }])).toEqual([]);
  });
});

describe("protocolDayChange —— 协议级 24h 增值聚合", () => {
  const row = (usdValue: number, change24h?: number, id = "r") => ({
    id,
    symbol: "X",
    amount: 1,
    usdValue,
    change24h,
  });
  it("多行聚合:delta = Σ 单行增值,pct 相对总敞口前值(缺 change24h 的行按现值计入分母)", () => {
    // 10100 涨 1% → 增值 100(前值 10000);负债 -5000 涨 0%(缺)→ 不计 delta,但计分母
    const c = protocolDayChange([row(10100, 1, "a"), row(-5000, undefined, "b")]);
    expect(c?.delta).toBeCloseTo(100);
    expect(c?.pct).toBeCloseTo((100 / 15000) * 100, 3); // ≈0.667%,分母 = 10000 + |−5000|
  });
  it("负债行(负值)升值 → 负贡献(债变贵)", () => {
    // -20400 涨 2% → 前值 -20000,增值 -400;pct 相对 |前值|
    const c = protocolDayChange([row(-20400, 2)]);
    expect(c?.delta).toBeCloseTo(-400);
    expect(c?.pct).toBeCloseTo(-2);
  });
  it("对冲仓(存≈借,净值近零)不产生荒谬百分比(分母是总敞口非净值)", () => {
    // 存 10100(+1% → +100)、借 -5050(+1% → -50):净前值仅 ~$50,若按净值分母 pct 会爆表
    const c = protocolDayChange([row(10100, 1, "a"), row(-5050, 1, "b")]);
    expect(c?.delta).toBeCloseTo(50);
    expect(Math.abs(c?.pct ?? 0)).toBeLessThan(1); // 50 / 15000 ≈ 0.33%
  });
  it("部分富化不夸大:分母含未富化大头寸", () => {
    // $100,000 无 change24h + $1,010(+1% → +10):% 相对全协议敞口而非小行
    const c = protocolDayChange([row(100000, undefined, "a"), row(1010, 1, "b")]);
    expect(c?.delta).toBeCloseTo(10);
    expect(c?.pct).toBeCloseTo((10 / 101000) * 100, 3); // ≈0.0099%
  });
  it("全行缺 change24h → null(UI 只显小计)", () => {
    expect(protocolDayChange([row(100), row(-50)])).toBeNull();
  });
});

// —— H5 评审:协议有值腿(丢空腿、按值降序) ——

import { type DefiRow, defiMeaningfulLegs } from "../src/lib/account-view";

describe("defiMeaningfulLegs", () => {
  const r = (id: string, usdValue: number, symbol = "X"): DefiRow => ({
    id,
    symbol,
    amount: usdValue,
    usdValue,
  });
  it("丢掉四舍五入为 0 的空腿,只留有值腿", () => {
    const legs = defiMeaningfulLegs([r("a", 500, "ETH"), r("b", 0), r("c", 0), r("d", 0)]);
    expect(legs.map((l) => l.symbol)).toEqual(["ETH"]);
  });
  it("按 |美元值| 降序", () => {
    const legs = defiMeaningfulLegs([r("a", 10), r("b", 500), r("c", 50), r("d", 200), r("e", 5)]);
    expect(legs.map((l) => l.usdValue)).toEqual([500, 200, 50, 10, 5]);
  });
  it("负债(负值)按绝对值排序参与", () => {
    const legs = defiMeaningfulLegs([r("a", 100), r("b", -9000)]);
    expect(legs[0].usdValue).toBe(-9000);
  });
  it("全是 sub-cent(组已过毛敞口阈值)→ 全展示,不截 1(否则漏腿)", () => {
    const legs = defiMeaningfulLegs([r("a", 0.003, "stETH"), r("b", 0.002, "rETH")]);
    expect(legs.map((l) => l.symbol)).toEqual(["stETH", "rETH"]);
  });
});

// —— H5 评审:摘要腿按角色分组(每条腿对应哪个角色) ——

import { groupLegsByRole } from "../src/lib/account-view";

describe("groupLegsByRole", () => {
  const r = (id: string, positionType?: string): DefiRow => ({
    id,
    symbol: "X",
    amount: 1,
    usdValue: 1,
    positionType,
  });
  it("按 positionType 分组,保持传入顺序(值降序)", () => {
    const g = groupLegsByRole([r("a", "deposit"), r("b", "deposit"), r("c", "loan")]);
    expect(g.map((x) => x.role)).toEqual(["deposit", "loan"]);
    expect(g[0].legs.map((l) => l.id)).toEqual(["a", "b"]);
    expect(g[1].legs.map((l) => l.id)).toEqual(["c"]);
  });
  it("无 positionType → role undefined 组", () => {
    const g = groupLegsByRole([r("a")]);
    expect(g).toEqual([{ role: undefined, legs: [r("a")] }]);
  });
});

// —— 空仓协议丢弃(整组毛敞口 < 半分钱 → 不展示,避免「协议 $0.00」噪音行) ——

import { dropEmptyDefiGroups } from "../src/lib/account-view";

describe("dropEmptyDefiGroups", () => {
  const leg = (usdValue: number): DefiRow => ({ id: "x", symbol: "X", amount: usdValue, usdValue });
  it("丢掉整组毛敞口≈0 的空仓(全 0 值残腿)", () => {
    const groups = [
      { protocol: "Morpho", rows: [leg(0), leg(0), leg(0)] },
      { protocol: "Lido", rows: [leg(92)] },
    ];
    expect(dropEmptyDefiGroups(groups).map((g) => g.protocol)).toEqual(["Lido"]);
  });
  it("保留净≈0 但有真实毛敞口的对冲仓(存+借相抵)", () => {
    const groups = [{ protocol: "Aave", rows: [leg(1000), leg(-1000)] }];
    expect(dropEmptyDefiGroups(groups).map((g) => g.protocol)).toEqual(["Aave"]);
  });
  it("单条 dust(<半分钱)也丢", () => {
    const groups = [{ protocol: "Dust", rows: [leg(0.001)] }];
    expect(dropEmptyDefiGroups(groups)).toEqual([]);
  });
});
