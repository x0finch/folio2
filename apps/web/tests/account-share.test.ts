import { describe, expect, it } from "vitest";
import {
  accountShare,
  activeAccountsTotal,
  shareLabel,
} from "../src/routes/_authed/-accounts/share";

// 归档 = 封存(ADR 0039)之后,归档行**有**市值了 —— 而分母仍然只能是活跃账户。
// 这条以前是靠「归档行的市值恒为 0」侥幸成立的,那个前提已经没了,所以显式钉一条。
describe("activeAccountsTotal 与归档", () => {
  it("归档账户有市值也不进分母", () => {
    expect(
      activeAccountsTotal([
        { totalUsd: 60, archivedAt: null },
        { totalUsd: 40, archivedAt: null },
        { totalUsd: 999, archivedAt: 1700000000000 },
      ]),
    ).toBe(100);
  });

  it("全部归档 → 分母 0 → 占比 0(不除零、不出负)", () => {
    const total = activeAccountsTotal([
      { totalUsd: 999, archivedAt: 1 },
      { totalUsd: 111, archivedAt: 2 },
    ]);
    expect(total).toBe(0);
    expect(accountShare(999, total)).toBe(0);
  });
});

describe("accountShare", () => {
  it("占比 = 账户市值 / 总计", () => {
    expect(accountShare(25, 100)).toBeCloseTo(0.25, 6);
    expect(accountShare(100, 100)).toBeCloseTo(1, 6);
  });

  it("总计为 0 → 0(避免除零)", () => {
    expect(accountShare(0, 0)).toBe(0);
    expect(accountShare(10, 0)).toBe(0);
  });

  it("总计为负(异常防御)→ 0", () => {
    expect(accountShare(10, -5)).toBe(0);
  });
});

describe("activeAccountsTotal", () => {
  it("只合计未归档账户的市值", () => {
    const rows = [
      { totalUsd: 60, archivedAt: null },
      { totalUsd: 40, archivedAt: null },
      { totalUsd: 999, archivedAt: 123 }, // 归档 → 不计入
    ];
    expect(activeAccountsTotal(rows)).toBe(100);
  });

  it("空列表 → 0", () => {
    expect(activeAccountsTotal([])).toBe(0);
  });
});

describe("shareLabel", () => {
  it('>0 且 <1 → "<1.0"', () => {
    expect(shareLabel(0.3)).toBe("<1.0");
    expect(shareLabel(0.99)).toBe("<1.0");
  });

  it('恰好 1 → "1.0"(不算小于 1)', () => {
    expect(shareLabel(1)).toBe("1.0");
  });

  it("≥1 → 一位小数", () => {
    expect(shareLabel(55.44)).toBe("55.4");
    expect(shareLabel(100)).toBe("100.0");
  });

  it('0 → "0.0"(非小于 1 的正数,照常)', () => {
    expect(shareLabel(0)).toBe("0.0");
  });
});
