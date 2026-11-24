import { describe, expect, it } from "vitest";
import {
  type DerivableActivity,
  deriveAmount,
  fallbackUnitPrice,
  type HistoryActivity,
  isReduceOversold,
  projectToken,
} from "@/lib/core/manual";
import { runningOk } from "@/lib/server/manual/batch";

const a = (
  kind: DerivableActivity["kind"],
  amount: number,
  occurredAt: number,
  createdAt = 0,
): DerivableActivity => ({ kind, amount, occurredAt, createdAt });

describe("deriveAmount", () => {
  it("empty → 0", () => {
    expect(deriveAmount([])).toBe(0);
  });

  it("no set → baseline 0 + deltas", () => {
    expect(deriveAmount([a("add", 5, 1), a("add", 3, 2), a("reduce", 2, 3)])).toBe(6);
  });

  it("set resets baseline (prior activity ignored), then deltas apply", () => {
    expect(deriveAmount([a("add", 5, 1), a("set", 10, 2), a("add", 2, 3)])).toBe(12);
  });

  it("last set wins among multiple sets", () => {
    expect(deriveAmount([a("set", 10, 1), a("add", 5, 2), a("set", 3, 3)])).toBe(3);
  });

  it("clamps at 0 (reduce more than held)", () => {
    expect(deriveAmount([a("add", 5, 1), a("reduce", 10, 2)])).toBe(0);
  });

  it("clamps at 0 per step: oversell mid-way zeroes out and carries no debt forward", () => {
    // add1 -> reduce2 (oversold, clamp 0) -> add1 => 1, not the end-clamped (1-2+1)=0.
    expect(deriveAmount([a("add", 1, 1), a("reduce", 2, 2), a("add", 1, 3)])).toBe(1);
  });

  it("buying after an oversell starts from 0 (no deduction)", () => {
    expect(deriveAmount([a("set", 10, 1), a("reduce", 15, 2), a("add", 3, 3)])).toBe(3);
  });

  it("orders by occurredAt then createdAt (insertion order tiebreak)", () => {
    // same occurredAt: set(createdAt 1) then add(createdAt 2) → 10 + 1 = 11
    expect(deriveAmount([a("add", 1, 5, 2), a("set", 10, 5, 1)])).toBe(11);
  });
});

// projectToken: token definition + activity ledger -> one creds.tokens entry.
describe("projectToken", () => {
  it("amount = deriveAmount(activities); no priced activity -> fallbackPrice is null", () => {
    const t = projectToken({ id: "tk1", symbol: "BTC" }, [a("set", 1, 1), a("add", 0.5, 2)]);
    expect(t).toEqual({ id: "tk1", symbol: "BTC", amount: 1.5, fallbackPrice: null, ref: null });
  });

  // ref is carried through opaquely.
  it("carries the ref through untouched", () => {
    const t = projectToken({ id: "tk1", symbol: "BTC", ref: "src/issued:bitcoin" }, [
      a("set", 2, 1),
    ]);
    expect(t).toEqual({
      id: "tk1",
      symbol: "BTC",
      amount: 2,
      fallbackPrice: null,
      ref: "src/issued:bitcoin",
    });
  });

  it("no ref (that namer hasn't identified it) → null, never undefined", () => {
    const t = projectToken({ id: "tk9", symbol: "FOO", ref: null }, []);
    expect(t).toEqual({ id: "tk9", symbol: "FOO", amount: 0, fallbackPrice: null, ref: null });
  });
});

// Custom-token pricing: declared price first, then the ledger. The history chart uses the opposite
// order on purpose (past points favor the ledger; the current value must follow the edit form).
describe("fallbackUnitPrice", () => {
  const priced = (price: number | null, occurredAt: number, createdAt = 1) => ({
    ...a("add", 1, occurredAt, createdAt),
    price,
  });

  it("takes the most recent priced activity in the ledger", () => {
    expect(fallbackUnitPrice([priced(888, 10), priced(999, 20)])).toBe(999);
  });

  it("only the opening activity -> uses it", () => {
    expect(fallbackUnitPrice([priced(777, 10)])).toBe(777);
  });

  it("activities without a price are skipped", () => {
    expect(fallbackUnitPrice([priced(null, 30), priced(888, 10)])).toBe(888);
  });

  it("two at the same instant -> the later-entered one wins (same as quantity folding)", () => {
    expect(fallbackUnitPrice([priced(1, 10, 1), priced(2, 10, 2)])).toBe(2);
  });

  it("no priced activity -> null (UI shows no price, not a fake $0)", () => {
    expect(fallbackUnitPrice([])).toBeNull();
    expect(fallbackUnitPrice([priced(null, 10)])).toBeNull();
  });
});

// Ledger quantities are float sums (0.1 + 0.2 - 0.3 = 5.55e-17). Write-path oversell guard, folded
// quantity and the oversold hint must share one tolerant fold, or sold-out tokens leave ghost dust.
describe("float: selling out is exactly 0, a normal sell is not oversold", () => {
  it("buy 0.1, buy 0.2, sell 0.3 -> exactly 0, no dust", () => {
    expect(deriveAmount([a("add", 0.1, 1), a("add", 0.2, 2), a("reduce", 0.3, 3)])).toBe(0);
  });

  it("buy 0.3, sell 0.1, sell 0.2 -> write path allows it and no oversold flag", () => {
    const acts = [a("add", 0.3, 1), a("reduce", 0.1, 2), a("reduce", 0.2, 3)];
    expect(runningOk(acts)).toBe(true);
    expect(isReduceOversold(acts as HistoryActivity[], acts[2]!)).toBe(false);
    expect(deriveAmount(acts)).toBe(0);
  });

  // Tolerance scales with magnitude: for huge supplies (SHIB-like) float error dwarfs 1e-9.
  it("large quantities hold too: buy 123456789.123 + 0.1, sell 123456789.223 -> 0", () => {
    const acts = [a("add", 123456789.123, 1), a("add", 0.1, 2), a("reduce", 123456789.223, 3)];
    expect(runningOk(acts)).toBe(true);
    expect(isReduceOversold(acts as HistoryActivity[], acts[2]!)).toBe(false);
    expect(deriveAmount(acts)).toBe(0);
  });

  it("a real oversell is still detected: hold 1, sell 1.0001 -> write rejects, flagged, folds to 0", () => {
    const acts = [a("add", 1, 1), a("reduce", 1.0001, 2)];
    expect(runningOk(acts)).toBe(false);
    expect(isReduceOversold(acts as HistoryActivity[], acts[1]!)).toBe(true);
    expect(deriveAmount(acts)).toBe(0);
  });

  it("real dust is not swallowed: 1 sat (1e-8 BTC) stays 1e-8", () => {
    expect(deriveAmount([a("add", 1, 1), a("reduce", 0.99999999, 2)])).toBeCloseTo(1e-8, 15);
  });

  // Invariant: a ledger the write path accepts has no oversold activity, and its folded quantity is
  // neither negative nor dust orders of magnitude below its smallest entry. Seeded random ledgers.
  it("random ledgers: runningOk accepted => no oversold flags, quantity is 0 or sane", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const dec = () => Math.round(rand() * 1000) / 100; // 0.00-10.00, two decimals
    let checked = 0;
    for (let n = 0; n < 2000; n++) {
      const acts: DerivableActivity[] = [];
      let held = 0;
      for (let i = 0; i < 2 + Math.floor(rand() * 8); i++) {
        // Sell part or all of the current holding so most ledgers are valid.
        const sell = rand() < 0.4 && held > 0;
        const amt = sell ? (rand() < 0.5 ? held : Math.round(held * rand() * 100) / 100) : dec();
        if (amt <= 0) continue;
        acts.push(a(sell ? "reduce" : "add", amt, i + 1));
        held = sell ? held - amt : held + amt;
      }
      if (!runningOk(acts)) continue;
      checked++;
      for (const act of acts) expect(isReduceOversold(acts as HistoryActivity[], act)).toBe(false);
      const amount = deriveAmount(acts);
      expect(amount).toBeGreaterThanOrEqual(0);
      expect(amount === 0 || amount >= 1e-6).toBe(true);
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
