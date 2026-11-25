import { describe, expect, it } from "vitest";
import { formatAmount, formatCents, formatWhole } from "../../src/runtime/note-format";

// These replace the per-parse `n.toLocaleString("en-US", { … })` (which boots ICU on first use in each isolate, see note-format.ts). Note text goes into
// snapshots and goldens and must not change by a single character, so Intl is the reference: hand-picked edges (rounding 5, carry chains,
// exponent form, negative zero) + a large batch of deterministic pseudo-random numbers.
const intl = (maxFrac: number) => (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });

const picked = [
  0,
  -0,
  1,
  -1,
  0.5,
  1.5,
  2.5,
  -2.5,
  1.005,
  2.675,
  0.125,
  1.23456789012,
  1234.5,
  1234567.891,
  -9876.54321,
  0.00012345,
  1e-9,
  -1e-9,
  5e-9,
  4.9999999e-9,
  0.000000005,
  0.999999995,
  9.995,
  99999.995,
  1e9 - 1e-7,
  12345678901.25,
  33.333333333,
  1e21,
  1.5e22,
  123456789012345680000,
  Number.MAX_SAFE_INTEGER,
  0.1 + 0.2,
  1 / 3,
  2 / 3,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

// Deterministic pseudo-random (mulberry32): magnitude from 1e-12 to 1e15, signed.
const randoms = (() => {
  let a = 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const magnitude = 10 ** Math.floor(next() * 27 - 12);
    const sign = next() < 0.2 ? -1 : 1;
    out.push(sign * next() * magnitude);
  }
  return out;
})();

describe("note number format is character-identical to toLocaleString", () => {
  it.each(picked)("%s", (n) => {
    expect(formatAmount(n)).toBe(intl(8)(n));
    expect(formatCents(n)).toBe(intl(2)(n));
    expect(formatWhole(n)).toBe(intl(0)(n));
  });

  it("3000 pseudo-random numbers (1e-12 … 1e15, signed)", () => {
    const mismatches = randoms.flatMap((n) =>
      [
        [formatAmount(n), intl(8)(n)],
        [formatCents(n), intl(2)(n)],
        [formatWhole(n), intl(0)(n)],
      ]
        .filter(([ours, theirs]) => ours !== theirs)
        .map(([ours, theirs]) => `${n}: ${ours} ≠ ${theirs}`),
    );
    expect(mismatches).toEqual([]);
  });
});
