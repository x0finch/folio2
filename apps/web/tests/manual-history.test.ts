import { describe, expect, it } from "vitest";
import type { SnapshotTotalRow } from "@/lib/core/history";
import {
  accountTotalAt,
  buildManualAccountSeries,
  type HistoryToken,
  isReduceOversold,
  tokenPriceAt,
  tokenQuantityAt,
} from "@/lib/core/manual";

// Ledger is the source of truth: value@T = quantity@T x price@T, recomputed on read.
const DAY = 86_400_000;
const T1 = 1 * DAY;
const T2 = 2 * DAY;
const T3 = 3 * DAY;

// createdAt only orders activities with the same occurredAt.
const act = (
  kind: "add" | "reduce" | "set",
  amount: number,
  occurredAt: number,
  price?: number | null,
  createdAt = occurredAt,
) => ({ kind, amount, occurredAt, createdAt, price });

describe("tokenQuantityAt", () => {
  it("folds activities with occurredAt <= T (set resets / add += / reduce -=)", () => {
    const tk: HistoryToken = {
      id: "tk",
      unitPrice: 10,
      activities: [act("set", 2, T1), act("add", 1, T2), act("reduce", 0.5, T3)],
    };
    expect(tokenQuantityAt(tk, T1)).toBe(2); // set only
    expect(tokenQuantityAt(tk, T2)).toBe(3); // set + add
    expect(tokenQuantityAt(tk, T3)).toBe(2.5); // set + add - reduce
    expect(tokenQuantityAt(tk, T1 - 1)).toBe(0); // no holding before set
  });

  it("reduce overshoots -> end value clamped to 0, never negative", () => {
    const tk: HistoryToken = {
      id: "tk",
      unitPrice: 10,
      activities: [act("set", 1, T1), act("reduce", 5, T2)],
    };
    expect(tokenQuantityAt(tk, T2)).toBe(0);
  });
});

describe("tokenPriceAt fallback chain", () => {
  const tk: HistoryToken = {
    id: "tk",
    unitPrice: 100,
    recognized: true,
    activities: [act("set", 1, T1, 60000), act("add", 1, T2, 65000), act("reduce", 0.5, T3, null)],
  };

  it("(2) ledger price: latest priced activity with occurredAt <= T", () => {
    expect(tokenPriceAt(tk, T1)).toBe(60000);
    expect(tokenPriceAt(tk, T2)).toBe(65000);
    expect(tokenPriceAt(tk, T3)).toBe(65000); // T3 has price=null -> falls back to T2's 65000
  });

  it("(3) flat unitPrice: no priced activity before that time", () => {
    const noPrice: HistoryToken = {
      id: "tk",
      unitPrice: 42,
      activities: [act("set", 1, T2, null)],
    };
    expect(tokenPriceAt(noPrice, T2)).toBe(42);
    // Before the first activity it also falls back to unitPrice.
    expect(tokenPriceAt(tk, T1 - 1)).toBe(100);
  });

  it("(1) injected priceAt (oracle history) beats ledger price", () => {
    const priceAt = (id: string, t: number) => (id === "tk" ? t / DAY + 0.5 : undefined);
    expect(tokenPriceAt(tk, T1, priceAt)).toBe(1.5); // oracle, not ledger 60000
    // priceAt returns undefined -> falls back to ledger price (2)
    const miss = (_id: string, _t: number) => undefined;
    expect(tokenPriceAt(tk, T2, miss)).toBe(65000);
    // Unrecognized upstream -> skip oracle, ledger price directly
    const local: HistoryToken = { id: "tk", unitPrice: 1, activities: [act("set", 1, T1, 7)] };
    expect(tokenPriceAt(local, T1, priceAt)).toBe(7);
  });
});

// Fiat cash: historical price is that day's FX rate, injected via priceAt by the server. The pure
// layer only sees the recognized+priceAt path, so the curve must follow the rate, not the ledger.
describe("fiat cash: historical price uses the injected daily rate (path 1)", () => {
  const eur: HistoryToken = {
    id: "eur",
    unitPrice: 0,
    recognized: true,
    fiatCode: "EUR",
    activities: [act("set", 100, T1, 1.15)], // ledger's frozen entry rate 1.15
  };
  // Per-day rate closure (stands in for the server's rateSeries).
  const fxAt = (id: string, t: number) =>
    id === "eur" ? { [T1]: 1.2, [T2]: 1.1, [T3]: 1.05 }[t] : undefined;

  it("each point uses that day's rate, not the frozen 1.15", () => {
    expect(tokenPriceAt(eur, T1, fxAt)).toBe(1.2);
    expect(tokenPriceAt(eur, T2, fxAt)).toBe(1.1);
    // 100 units -> account value follows the rate: T1 = 120, T2 = 110 (not a constant 115).
    expect(accountTotalAt([eur], T1, fxAt)).toBeCloseTo(120, 6);
    expect(accountTotalAt([eur], T2, fxAt)).toBeCloseTo(110, 6);
  });

  it("USD cash: rate is always 1 -> plain quantity, unchanged behavior", () => {
    const usd: HistoryToken = {
      id: "usd",
      unitPrice: 0,
      recognized: true,
      fiatCode: "USD",
      activities: [act("set", 500, T1, 1)],
    };
    const one = (_id: string, _t: number) => 1; // USD is always 1
    expect(accountTotalAt([usd], T1, one)).toBe(500);
    expect(accountTotalAt([usd], T3, one)).toBe(500);
  });

  it("upstream missing that day -> priceAt returns undefined -> falls back to ledger price (no crash)", () => {
    const miss = (_id: string, _t: number) => undefined;
    expect(tokenPriceAt(eur, T1, miss)).toBe(1.15); // falls back to the frozen ledger price
  });
});

// Sample grid: first-activity anchor + each UTC day end after it + now. First point is the first
// activity and last is now, so any account with activity has >= 2 points (the drawer needs >= 2).
// DAY-aligned occurredAt keeps bucket math clean; dayEnd(b) = (b+1)*DAY - 1.
describe("accountTotalAt", () => {
  it("sum over tokens of quantity@t x price@t (ledger price)", () => {
    const btc: HistoryToken = { id: "tk", unitPrice: 100, activities: [act("set", 2, T1, 60000)] };
    const eth: HistoryToken = { id: "tk", unitPrice: 10, activities: [act("set", 3, T1, 3000)] };
    expect(accountTotalAt([btc, eth], T1)).toBe(2 * 60000 + 3 * 3000);
    expect(accountTotalAt([btc, eth], T1 - 1)).toBe(0); // before opening
  });
});

describe("isReduceOversold", () => {
  it("reduce exceeds the prior holding -> true", () => {
    const acts = [act("add", 1, T1), act("reduce", 2, T2)];
    expect(isReduceOversold(acts, acts[1])).toBe(true); // hold 1, sell 2
  });
  it("an earlier opening covers it -> false", () => {
    const acts = [act("set", 10, 0), act("add", 1, T1), act("reduce", 2, T2)];
    expect(isReduceOversold(acts, acts[2])).toBe(false); // hold 11, sell 2
  });
  it("sells exactly to 0 (not over) -> false", () => {
    const acts = [act("add", 1, T1), act("reduce", 1, T2)];
    expect(isReduceOversold(acts, acts[1])).toBe(false);
  });
  it("not a reduce -> false", () => {
    const acts = [act("add", 1, T1)];
    expect(isReduceOversold(acts, acts[0])).toBe(false);
  });
});

describe("buildManualAccountSeries(grid, ADR 0019)", () => {
  const last = (s: SnapshotTotalRow[]) => s[s.length - 1];

  it("single same-day activity -> first activity + now, two points, drawable", () => {
    const btc: HistoryToken = { id: "tk", unitPrice: 100, activities: [act("set", 2, T1, 60000)] };
    const now = T1 + 6 * 3_600_000; // 6h later the same day (T1 is day start, still bucket 1)
    const series = buildManualAccountSeries("acc", [btc], now);
    expect(series.length).toBeGreaterThanOrEqual(2); // a same-day account still gets >= 2 points
    expect(series[0].takenAt).toBe(T1); // anchored at the first activity
    expect(last(series).takenAt).toBe(now); // last point = now
    expect(series.every((p) => p.totalUsd === 2 * 60000)).toBe(true); // holding 2 x ledger price
  });

  it("(1) injected priceAt (oracle history) drives price per day; curve follows across days", () => {
    const btc: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      recognized: true,
      activities: [act("set", 1, T1, 60000)],
    };
    // priceAt prices per day bucket (1000 x bucket) -> oracle price, not ledger 60000.
    const priceAt = (id: string, t: number) =>
      id === "tk" ? 1000 * Math.floor(t / DAY) : undefined;
    const series = buildManualAccountSeries("acc", [btc], T3, priceAt);
    expect(series[0]).toEqual({ accountId: "acc", takenAt: T1, totalUsd: 1000 }); // bucket 1
    expect(last(series)).toEqual({ accountId: "acc", takenAt: T3, totalUsd: 3000 }); // bucket 3
    expect(series.length).toBeGreaterThan(2); // intermediate day points reflect price moves
    const totals = series.map((p) => p.totalUsd);
    expect(totals).toEqual([...totals].sort((a, b) => a - b)); // quantity 1 -> monotone
  });

  it("holding outside the window: first activity long before now, curve runs to now with folded holdings", () => {
    const btc: HistoryToken = { id: "tk", unitPrice: 100, activities: [act("set", 2, T1, 60000)] };
    const now = T1 + 4 * DAY; // 4 days after the first activity
    const series = buildManualAccountSeries("acc", [btc], now);
    expect(series[0].takenAt).toBe(T1);
    expect(last(series).takenAt).toBe(now);
    expect(series.length).toBeGreaterThanOrEqual(5); // first activity + daily + now
    expect(series.every((p) => p.totalUsd === 2 * 60000)).toBe(true);
  });

  it("empty account / no activities -> empty series", () => {
    expect(buildManualAccountSeries("acc", [], T3)).toEqual([]);
    expect(
      buildManualAccountSeries("acc", [{ id: "tk", unitPrice: 5, activities: [] }], T3),
    ).toEqual([]);
  });

  it("backdating an earlier activity -> start moves to it, whole series recomputed", () => {
    const before: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      activities: [act("set", 1, T2, 50000)],
    };
    expect(buildManualAccountSeries("acc", [before], T3)[0].takenAt).toBe(T2); // the only activity

    // Backdate "bought 0.5 at T1" -> start moves to T1; at T3 the set still resets to 1.
    const after: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      activities: [act("add", 0.5, T1, 40000), act("set", 1, T2, 50000)],
    };
    const series = buildManualAccountSeries("acc", [after], T3);
    expect(series[0]).toEqual({ accountId: "acc", takenAt: T1, totalUsd: 0.5 * 40000 });
    expect(last(series)).toEqual({ accountId: "acc", takenAt: T3, totalUsd: 1 * 50000 }); // set resets
  });

  it("deleting a past activity -> full recompute, no stale values", () => {
    const full: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      activities: [act("set", 1, T1, 40000), act("add", 2, T2, 50000)],
    };
    // Last point T3: quantity 1+2=3, latest price 50000.
    expect(last(buildManualAccountSeries("acc", [full], T3)).totalUsd).toBe(3 * 50000);

    // Drop the T2 add -> quantity back to 1 (the set), not the old 3x50000.
    const pruned: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      activities: [act("set", 1, T1, 40000)],
    };
    const s = buildManualAccountSeries("acc", [pruned], T3);
    expect(s[0].takenAt).toBe(T1);
    expect(last(s).totalUsd).toBe(1 * 40000);
  });

  it("editing a past activity amount -> downstream recomputed", () => {
    const edited: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      activities: [act("set", 3, T1, 40000), act("add", 1, T2, 50000)],
    };
    const series = buildManualAccountSeries("acc", [edited], T3);
    expect(series[0]).toEqual({ accountId: "acc", takenAt: T1, totalUsd: 3 * 40000 });
    expect(last(series)).toEqual({ accountId: "acc", takenAt: T3, totalUsd: 4 * 50000 });
  });
});
