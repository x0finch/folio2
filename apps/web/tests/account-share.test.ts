import { describe, expect, it } from "vitest";
import {
  accountShare,
  activeAccountsTotal,
  shareLabel,
} from "@/routes/_authed/-accounts/list-rows";

// Archived rows carry a frozen value, but the denominator must stay active accounts only.
describe("activeAccountsTotal and archived accounts", () => {
  it("archived accounts with a value stay out of the denominator", () => {
    expect(
      activeAccountsTotal([
        { totalUsd: 60, archivedAt: null },
        { totalUsd: 40, archivedAt: null },
        { totalUsd: 999, archivedAt: 1700000000000 },
      ]),
    ).toBe(100);
  });

  it("all archived → denominator 0 → share 0 (no divide-by-zero, no negatives)", () => {
    const total = activeAccountsTotal([
      { totalUsd: 999, archivedAt: 1 },
      { totalUsd: 111, archivedAt: 2 },
    ]);
    expect(total).toBe(0);
    expect(accountShare(999, total)).toBe(0);
  });
});

describe("accountShare", () => {
  it("share = account value / total", () => {
    expect(accountShare(25, 100)).toBeCloseTo(0.25, 6);
    expect(accountShare(100, 100)).toBeCloseTo(1, 6);
  });

  it("total 0 → 0 (avoid divide-by-zero)", () => {
    expect(accountShare(0, 0)).toBe(0);
    expect(accountShare(10, 0)).toBe(0);
  });

  it("negative total (defensive) → 0", () => {
    expect(accountShare(10, -5)).toBe(0);
  });
});

describe("activeAccountsTotal", () => {
  it("empty list → 0", () => {
    expect(activeAccountsTotal([])).toBe(0);
  });
});

describe("shareLabel", () => {
  it('>0 and <1 → "<1.0"', () => {
    expect(shareLabel(0.3)).toBe("<1.0");
    expect(shareLabel(0.99)).toBe("<1.0");
  });

  it('exactly 1 → "1.0" (not below 1)', () => {
    expect(shareLabel(1)).toBe("1.0");
  });

  it("≥1 → one decimal place", () => {
    expect(shareLabel(55.44)).toBe("55.4");
    expect(shareLabel(100)).toBe("100.0");
  });

  it('0 → "0.0" (not a positive below 1, formatted normally)', () => {
    expect(shareLabel(0)).toBe("0.0");
  });
});
