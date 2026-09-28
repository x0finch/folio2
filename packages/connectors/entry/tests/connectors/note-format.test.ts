import { describe, expect, it } from "vitest";
import { formatAmount, formatCents, formatWhole } from "../../src/connectors/note-format";

// 这三个取代的是 parse 里各自的 `n.toLocaleString("en-US", { … })`(那个写法在每个 isolate 里第一次
// 用就要拉起 ICU,见 note-format.ts)。note 的文案进快照、进 golden,**一个字符都不能变** —— 所以
// 直接拿 Intl 当对照:手挑的边界(舍入的 5、进位连锁、指数形式、负零)+ 一大批确定性的伪随机数。
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

// 确定性的伪随机(mulberry32):量级从 1e-12 到 1e15,带符号。
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

describe("note 数字格式与 toLocaleString 逐字相同", () => {
  it.each(picked)("%s", (n) => {
    expect(formatAmount(n)).toBe(intl(8)(n));
    expect(formatCents(n)).toBe(intl(2)(n));
    expect(formatWhole(n)).toBe(intl(0)(n));
  });

  it("3000 个伪随机数(1e-12 … 1e15,带符号)", () => {
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
