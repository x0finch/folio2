import { describe, expect, it } from "vitest";
import { formatNumber } from "../src/lib/format-number";

describe("formatNumber — 空值/非法值", () => {
  it("null / undefined / 空串 / NaN / ±Infinity / 非数字串 → '-'", () => {
    expect(formatNumber(null)).toBe("-");
    expect(formatNumber(undefined)).toBe("-");
    expect(formatNumber("")).toBe("-");
    expect(formatNumber(Number.NaN)).toBe("-");
    expect(formatNumber(Infinity)).toBe("-");
    expect(formatNumber(-Infinity)).toBe("-");
    expect(formatNumber("abc")).toBe("-");
  });
});

describe("formatNumber — 零", () => {
  it("0 / -0 / '0';unit 前缀", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber("0")).toBe("0");
    expect(formatNumber(0, { unit: "$" })).toBe("$0");
  });
});

describe("formatNumber — 常规(千分位 + 最多 2 位小数,去尾零)", () => {
  it("0.01 ≤ |n| < 1e8", () => {
    expect(formatNumber(5)).toBe("5");
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatNumber(1234.5678)).toBe("1,234.57"); // 2 位四舍五入
    expect(formatNumber(28653258.017334502)).toBe("28,653,258.02");
    expect(formatNumber(0.12345678)).toBe("0.12");
    expect(formatNumber(99999999)).toBe("99,999,999"); // 仍未到 1e8
  });

  it("阈值边界:0.01 走常规,略低走下标", () => {
    expect(formatNumber(0.01)).toBe("0.01");
    expect(formatNumber(0.009)).toBe("0.0₂9");
  });
});

describe("formatNumber — 大额(紧凑,≥1e8)", () => {
  it("默认 compact:M/B/T(最多 2 位)", () => {
    expect(formatNumber(100_000_000)).toBe("100M");
    expect(formatNumber(123_456_789)).toBe("123.46M");
    expect(formatNumber(1_500_000_000)).toBe("1.5B");
    expect(formatNumber(1e12)).toBe("1T");
  });

  it("compact:false → 走常规千分位", () => {
    expect(formatNumber(123_456_789, { compact: false })).toBe("123,456,789");
  });
});

describe("formatNumber — 极小数(下标记法,0 < |n| < 0.01)", () => {
  it("下标 = 前导零个数,两位有效数字(四舍五入,修复旧版截断)", () => {
    expect(formatNumber(0.005)).toBe("0.0₂5");
    expect(formatNumber(0.0000456)).toBe("0.0₄46"); // 旧版截断成 45
    expect(formatNumber(1e-7)).toBe("0.0₆1");
    expect(formatNumber(0.005, { unit: "$" })).toBe("$0.0₂5");
  });

  it("多位下标 / 进位越界回退 / 进位改变零个数", () => {
    expect(formatNumber(1e-11)).toBe("0.0₁₀1");
    expect(formatNumber(0.00999)).toBe("0.01"); // 进位到 0.01 回退常规
    expect(formatNumber(0.0000999)).toBe("0.0₃1"); // ≈ 0.0001,零 4→3
  });
});

describe("formatNumber — 负数(修复旧版 '-undefined')", () => {
  it("负号在最前;无 unit 也正常", () => {
    expect(formatNumber(-1234.5)).toBe("-1,234.5");
    expect(formatNumber(-1234.5, { unit: "$" })).toBe("-$1,234.5");
    expect(formatNumber(-0.005)).toBe("-0.0₂5");
    expect(formatNumber(-0.0000456)).toBe("-0.0₄46");
    expect(formatNumber(-123_456_789)).toBe("-123.46M");
  });
});

describe("formatNumber — unit / bigint / string", () => {
  it("unit 前缀", () => {
    expect(formatNumber(1234.5, { unit: "$" })).toBe("$1,234.5");
  });

  it("bigint(修复旧版全 '-')", () => {
    expect(formatNumber(0n)).toBe("0");
    expect(formatNumber(1234n)).toBe("1,234");
    expect(formatNumber(-1234n)).toBe("-1,234");
    expect(formatNumber(123_456_789n)).toBe("123.46M");
  });

  it("string 先 Number() 再格式化", () => {
    expect(formatNumber("1234.5")).toBe("1,234.5");
    expect(formatNumber("-0.005")).toBe("-0.0₂5");
  });
});

describe("formatNumber — 可调小数位 / locale", () => {
  it("maxFractionDigits 覆盖默认 2", () => {
    expect(formatNumber(1.23456)).toBe("1.23"); // 默认 2
    expect(formatNumber(1.23456, { maxFractionDigits: 4 })).toBe("1.2346"); // 覆盖为 4
  });

  it("跟随 locale:zh 千分位一致,紧凑记法本地化(亿)", () => {
    expect(formatNumber(1234.5, { locale: "zh" })).toBe("1,234.5");
    expect(formatNumber(123_456_789, { locale: "zh" })).toContain("亿");
  });
});
