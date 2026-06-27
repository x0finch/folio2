import { describe, expect, it } from "vitest";
import { buildPortfolioHistory } from "../src/lib/history";

describe("buildPortfolioHistory", () => {
  it("steps the portfolio total as each account is (re)synced at different times", () => {
    // a1@1000=10 → a2@1500=5(总额 15)→ a1@2000=20(总额 25:a1 更新、a2 保留)
    const series = buildPortfolioHistory([
      { accountId: "a1", takenAt: 1000, totalUsd: 10 },
      { accountId: "a2", takenAt: 1500, totalUsd: 5 },
      { accountId: "a1", takenAt: 2000, totalUsd: 20 },
    ]);
    expect(series).toEqual([
      { t: 1000, total: 10 },
      { t: 1500, total: 15 },
      { t: 2000, total: 25 },
    ]);
  });

  it("merges same-timestamp multi-account events into a single point", () => {
    const series = buildPortfolioHistory([
      { accountId: "a1", takenAt: 1000, totalUsd: 10 },
      { accountId: "a2", takenAt: 1000, totalUsd: 7 },
    ]);
    expect(series).toEqual([{ t: 1000, total: 17 }]);
  });

  it("sorts unsorted input by takenAt", () => {
    const series = buildPortfolioHistory([
      { accountId: "a1", takenAt: 2000, totalUsd: 20 },
      { accountId: "a1", takenAt: 1000, totalUsd: 10 },
    ]);
    expect(series.map((p) => p.t)).toEqual([1000, 2000]);
    expect(series.map((p) => p.total)).toEqual([10, 20]);
  });

  it("handles a single account and empty input", () => {
    expect(buildPortfolioHistory([{ accountId: "a", takenAt: 5, totalUsd: 3 }])).toEqual([
      { t: 5, total: 3 },
    ]);
    expect(buildPortfolioHistory([])).toEqual([]);
  });
});
