import { describe, expect, it } from "vitest";
import { type OverviewBalance, toAccountSections } from "@/lib/core/account-view";

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

  it("drops dust spot rows (unpriced/airdrops, below the dust threshold)", () => {
    const s = toAccountSections([
      b({ id: "1", symbol: "ETH", usdValue: 5000, kind: "spot" }),
      b({ id: "2", symbol: "SPAM", usdValue: 0, kind: "spot" }), // unpriced → excluded
      b({ id: "3", symbol: "DUST", usdValue: 0.05, kind: "spot" }), // < ZERO_DISPLAY_USD ($0.10) → excluded
    ]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["ETH"]);
  });

  it("passes a balance-level note through to SpotRow.note", () => {
    const note = {
      title: "Locked",
      icon: "warning" as const,
      content: [{ label: "ETH", value: 1, unit: "ETH" }],
    };
    const s = toAccountSections([
      b({ id: "1", symbol: "ETH", usdValue: 5000, kind: "spot", note }),
      b({ id: "2", symbol: "BTC", usdValue: 100, kind: "spot" }), // row without a note
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
      b({ id: "4", symbol: "MYST", kind: "defi", usdValue: 10, metaJson: null }), // no protocol → fallback
    ]);
    expect(s.defi.map((g) => g.protocol)).toEqual(["Aave", "Uniswap", "Other"]);
    const aave = s.defi[0];
    expect(aave.rows.map((r) => r.symbol)).toEqual(["aUSDC", "aETH"]);
    expect(aave.rows[1].usdValue).toBe(-2500); // debt kept
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

  it("legacy kind=utxo falls into the spot table (viewKind default)", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "BTC",
        kind: "utxo", // legacy kind from old snapshots; viewKind defaults to spot
        usdValue: 5000,
        metaJson: JSON.stringify({ pendingSats: 12345 }),
      }),
    ]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["BTC"]);
  });

  it("kind=perp_equity/perp_position use the perp view", () => {
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

  it("unknown kind falls back to spot (no throw)", () => {
    const s = toAccountSections([b({ id: "1", symbol: "???", kind: "mystery", usdValue: 1 })]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["???"]);
  });
});

import { type DefiRow, defiMeaningfulLegs, mergeDefiGroups } from "@/lib/core/account-view";

describe("mergeDefiGroups — merges by protocol across accounts, order preserved", () => {
  const g = (protocol: string, id: string, usdValue = 1) => ({
    protocol,
    rows: [{ id, symbol: "X", amount: 1, usdValue }],
  });
  it("same-protocol rows join the first-seen group; groups ordered by first appearance", () => {
    const merged = mergeDefiGroups([
      { defi: [g("Aave", "a1"), g("Lido", "l1")] },
      { defi: [g("Aave", "a2")] },
      { defi: [] },
    ]);
    expect(merged.map((x) => x.protocol)).toEqual(["Aave", "Lido"]);
    expect(merged[0].rows.map((r) => r.id)).toEqual(["a1", "a2"]);
  });
  it("all empty → []", () => {
    expect(mergeDefiGroups([{ defi: [] }])).toEqual([]);
  });
});

describe("defiMeaningfulLegs", () => {
  const r = (id: string, usdValue: number, symbol = "X"): DefiRow => ({
    id,
    symbol,
    amount: usdValue,
    usdValue,
  });
  it("drops legs that round to 0, keeps those with value", () => {
    const legs = defiMeaningfulLegs([r("a", 500, "ETH"), r("b", 0), r("c", 0), r("d", 0)]);
    expect(legs.map((l) => l.symbol)).toEqual(["ETH"]);
  });
  it("sorts by |USD value| descending", () => {
    const legs = defiMeaningfulLegs([r("a", 10), r("b", 500), r("c", 50), r("d", 200), r("e", 5)]);
    expect(legs.map((l) => l.usdValue)).toEqual([500, 200, 50, 10, 5]);
  });
  it("debts (negative) sort by absolute value", () => {
    const legs = defiMeaningfulLegs([r("a", 100), r("b", -9000)]);
    expect(legs[0].usdValue).toBe(-9000);
  });
  it("all sub-cent (group already past the gross threshold) → show all, don't cut to 1 (would hide legs)", () => {
    const legs = defiMeaningfulLegs([r("a", 0.003, "stETH"), r("b", 0.002, "rETH")]);
    expect(legs.map((l) => l.symbol)).toEqual(["stETH", "rETH"]);
  });
});

import { groupLegsByRole } from "@/lib/core/account-view";

describe("groupLegsByRole", () => {
  const r = (id: string, positionType?: string): DefiRow => ({
    id,
    symbol: "X",
    amount: 1,
    usdValue: 1,
    positionType,
  });
  it("groups by positionType, preserving input order (value descending)", () => {
    const g = groupLegsByRole([r("a", "deposit"), r("b", "deposit"), r("c", "loan")]);
    expect(g.map((x) => x.role)).toEqual(["deposit", "loan"]);
    expect(g[0].legs.map((l) => l.id)).toEqual(["a", "b"]);
    expect(g[1].legs.map((l) => l.id)).toEqual(["c"]);
  });
  it("no positionType → group with role undefined", () => {
    const g = groupLegsByRole([r("a")]);
    expect(g).toEqual([{ role: undefined, legs: [r("a")] }]);
  });
});

// Groups with gross exposure under half a cent are dropped to avoid "$0.00" protocol rows.

import { dropEmptyDefiGroups } from "@/lib/core/account-view";

describe("dropEmptyDefiGroups", () => {
  const leg = (usdValue: number): DefiRow => ({ id: "x", symbol: "X", amount: usdValue, usdValue });
  it("drops a group whose gross exposure ≈ 0 (all-zero leftover legs)", () => {
    const groups = [
      { protocol: "Morpho", rows: [leg(0), leg(0), leg(0)] },
      { protocol: "Lido", rows: [leg(92)] },
    ];
    expect(dropEmptyDefiGroups(groups).map((g) => g.protocol)).toEqual(["Lido"]);
  });
  it("keeps a hedge netting ≈ 0 with real gross exposure (supply + borrow)", () => {
    const groups = [{ protocol: "Aave", rows: [leg(1000), leg(-1000)] }];
    expect(dropEmptyDefiGroups(groups).map((g) => g.protocol)).toEqual(["Aave"]);
  });
  it("drops a single dust leg (< half a cent) too", () => {
    const groups = [{ protocol: "Dust", rows: [leg(0.001)] }];
    expect(dropEmptyDefiGroups(groups)).toEqual([]);
  });
});

describe("mergeDefiGroups — 24h P&L merged across accounts (endpoint subtraction)", () => {
  const g = (protocol: string, amount: number, start: number) => ({
    protocol,
    rows: [{ id: "x", symbol: "S", amount: 1, usdValue: 100 }],
    gain24h: { amount, pct: start > 0 ? (amount / start) * 100 : null, start },
  });

  it("amounts add, percent is recomputed (Σ amount ÷ Σ start value), not averaged per account", () => {
    // A: +10 from 100 (+10%); B: +10 from 900 (+1.11%). Average is 5.56%; correct is 20/1000 = 2%.
    const merged = mergeDefiGroups([
      { defi: [g("Lido", 10, 100)] },
      { defi: [g("Lido", 10, 900)] },
    ]);
    expect(merged[0].gain24h?.amount).toBeCloseTo(20, 6);
    expect(merged[0].gain24h?.pct).toBeCloseTo(2, 6);
    expect(merged[0].gain24h?.pct).not.toBeCloseTo(5.56, 1);
  });

  it("computable if any one account is — same stance as 'only lines with a baseline count'", () => {
    const merged = mergeDefiGroups([
      { defi: [g("Lido", 10, 100)] },
      { defi: [{ protocol: "Lido", rows: [], gain24h: null }] },
    ]);
    expect(merged[0].gain24h?.amount).toBeCloseTo(10, 6);
  });

  it("none computable → null", () => {
    const merged = mergeDefiGroups([{ defi: [{ protocol: "Lido", rows: [], gain24h: null }] }]);
    expect(merged[0].gain24h).toBeNull();
  });
});
