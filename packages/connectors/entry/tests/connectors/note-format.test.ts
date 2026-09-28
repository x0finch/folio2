import { describe, expect, it } from "vitest";
import { formatAmount, formatCents, formatWhole } from "../../src/connectors/note-format";

// 这三个取代的是 parse 里各自的 `n.toLocaleString("en-US", { … })`(那个写法每调用一次现造一个
// formatter,见 note-format.ts)。note 的文案进快照、进 golden,**一个字符都不能变** —— 所以直接拿
// 旧写法当对照,一串覆盖千分位 / 小数截断 / 负数 / 0 / 极小值的数逐个比。
const samples = [
  0, 1, -1, 0.5, 1.23456789012, 1234.5, 1234567.891, -9876.54321, 0.00012345, 1e-9, 12345678901.25,
  33.333333333,
];

describe("note 数字格式与 toLocaleString 逐字相同", () => {
  it.each(samples)("%s", (n) => {
    expect(formatAmount(n)).toBe(n.toLocaleString("en-US", { maximumFractionDigits: 8 }));
    expect(formatCents(n)).toBe(n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
    expect(formatWhole(n)).toBe(n.toLocaleString("en-US", { maximumFractionDigits: 0 }));
  });
});
