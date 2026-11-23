import type { Currency } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { formatMoney, formatNumber } from "@/lib/core/format-number";

// Logo is irrelevant to formatting; empty placeholder.
const USD: Currency = { code: "USD", kind: "fiat", logo: "" };
const EUR: Currency = { code: "EUR", kind: "fiat", logo: "" };
const JPY: Currency = { code: "JPY", kind: "fiat", logo: "" };
const BTC: Currency = { code: "BTC", kind: "crypto", symbol: "₿", logo: "" };

describe("formatNumber — empty/invalid", () => {
  it("null / undefined / empty string / NaN / ±Infinity / non-numeric string → '-'", () => {
    expect(formatNumber(null)).toBe("-");
    expect(formatNumber(undefined)).toBe("-");
    expect(formatNumber("")).toBe("-");
    expect(formatNumber(Number.NaN)).toBe("-");
    expect(formatNumber(Infinity)).toBe("-");
    expect(formatNumber(-Infinity)).toBe("-");
    expect(formatNumber("abc")).toBe("-");
  });
});

describe("formatNumber — zero", () => {
  it("0 / -0 / '0'; unit prefix", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber("0")).toBe("0");
    expect(formatNumber(0, { unit: "$" })).toBe("$0");
  });
});

describe("formatNumber — regular (grouping + up to 2 decimals, trailing zeros trimmed)", () => {
  it("0.01 ≤ |n| < 1e8", () => {
    expect(formatNumber(5)).toBe("5");
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatNumber(1234.5678)).toBe("1,234.57"); // rounded to 2 places
    expect(formatNumber(28653258.017334502)).toBe("28,653,258.02");
    expect(formatNumber(0.12345678)).toBe("0.12");
    expect(formatNumber(99999999)).toBe("99,999,999"); // still below 1e8
  });

  it("threshold: 0.01 is regular, just below uses subscript", () => {
    expect(formatNumber(0.01)).toBe("0.01");
    expect(formatNumber(0.009)).toBe("0.0₂9");
  });
});

describe("formatNumber — large (compact, ≥1e8)", () => {
  it("compact by default: M/B/T (up to 2 places)", () => {
    expect(formatNumber(100_000_000)).toBe("100M");
    expect(formatNumber(123_456_789)).toBe("123.46M");
    expect(formatNumber(1_500_000_000)).toBe("1.5B");
    expect(formatNumber(1e12)).toBe("1T");
  });

  it("compact:false → regular grouping", () => {
    expect(formatNumber(123_456_789, { compact: false })).toBe("123,456,789");
  });
});

describe("formatNumber — tiny (subscript notation, 0 < |n| < 0.01)", () => {
  it("subscript = leading zero count, two significant digits (rounded, not truncated)", () => {
    expect(formatNumber(0.005)).toBe("0.0₂5");
    expect(formatNumber(0.0000456)).toBe("0.0₄46"); // truncation would give 45
    expect(formatNumber(1e-7)).toBe("0.0₆1");
    expect(formatNumber(0.005, { unit: "$" })).toBe("$0.0₂5");
  });

  it("multi-digit subscript / rounding overflow falls back / rounding changes the zero count", () => {
    expect(formatNumber(1e-11)).toBe("0.0₁₀1");
    expect(formatNumber(0.00999)).toBe("0.01"); // rounds to 0.01 → regular
    expect(formatNumber(0.0000999)).toBe("0.0₃1"); // ≈ 0.0001, zeros 4→3
  });
});

describe("formatNumber — negatives", () => {
  it("minus sign first; works without a unit", () => {
    expect(formatNumber(-1234.5)).toBe("-1,234.5");
    expect(formatNumber(-1234.5, { unit: "$" })).toBe("-$1,234.5");
    expect(formatNumber(-0.005)).toBe("-0.0₂5");
    expect(formatNumber(-0.0000456)).toBe("-0.0₄46");
    expect(formatNumber(-123_456_789)).toBe("-123.46M");
  });
});

describe("formatNumber — unit / bigint / string", () => {
  it("unit prefix", () => {
    expect(formatNumber(1234.5, { unit: "$" })).toBe("$1,234.5");
  });

  it("bigint", () => {
    expect(formatNumber(0n)).toBe("0");
    expect(formatNumber(1234n)).toBe("1,234");
    expect(formatNumber(-1234n)).toBe("-1,234");
    expect(formatNumber(123_456_789n)).toBe("123.46M");
  });

  it("string goes through Number() first", () => {
    expect(formatNumber("1234.5")).toBe("1,234.5");
    expect(formatNumber("-0.005")).toBe("-0.0₂5");
  });
});

describe("formatNumber — fraction digits / locale", () => {
  it("maxFractionDigits overrides the default 2", () => {
    expect(formatNumber(1.23456)).toBe("1.23"); // default 2
    expect(formatNumber(1.23456, { maxFractionDigits: 4 })).toBe("1.2346"); // overridden to 4
  });

  it("follows locale: zh grouping matches, compact notation localized", () => {
    expect(formatNumber(1234.5, { locale: "zh" })).toBe("1,234.5");
    expect(formatNumber(123_456_789, { locale: "zh" })).toContain("亿");
  });
});

describe("formatMoney — fiat(Intl currency style)", () => {
  it("USD pads to two decimals ($5 → $5.00)", () => {
    expect(formatMoney(5, { currency: USD })).toBe("$5.00");
    expect(formatMoney(1234.5, { currency: USD })).toBe("$1,234.50");
    expect(formatMoney(0, { currency: USD })).toBe("$0.00");
  });

  it("JPY has no decimals (per currency)", () => {
    expect(formatMoney(1234.567, { currency: JPY })).toBe("¥1,235");
  });

  it("rate conversion: shown value = usd / rate", () => {
    expect(formatMoney(100, { currency: EUR, rate: 2 })).toBe("€50.00");
  });

  it("tiny values use the subscript currency form", () => {
    expect(formatMoney(0.005, { currency: USD })).toBe("$0.0₂5");
  });

  it("≥1e8 compact", () => {
    expect(formatMoney(123_456_789, { currency: USD })).toBe("$123.46M");
  });
});

describe("formatMoney — crypto (₿/Ξ prefix + high precision)", () => {
  it("prefix + high-precision number", () => {
    expect(formatMoney(50000, { currency: BTC, rate: 100000 })).toBe("₿0.5");
    expect(formatMoney(1_250_000, { currency: BTC, rate: 100000 })).toBe("₿12.5");
  });

  it("tiny value subscript", () => {
    expect(formatMoney(0.1, { currency: BTC, rate: 100000 })).toBe("₿0.0₅1");
  });

  it("negative: minus before the symbol", () => {
    expect(formatMoney(-50000, { currency: BTC, rate: 100000 })).toBe("-₿0.5");
  });
});
