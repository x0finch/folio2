import { describe, expect, it } from "vitest";
import {
  buildPortfolioHistory,
  downsampleSeries,
  type HistoryPoint,
  toDailySeries,
  toPortfolioCurve,
} from "@/lib/core/history";

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("buildPortfolioHistory", () => {
  it("steps the portfolio total as each account is (re)synced at different times", () => {
    // a1@1000=10 → a2@1500=5 (total 15) → a1@2000=20 (total 25: a1 updated, a2 held)
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

  // An archived account stops contributing after its archive time; earlier points stay. Without the cut, its
  // frozen value would be carried to today while the live point counts only active accounts.
  describe("archived members contribute only until their archive time", () => {
    it("points after archiving exclude it; points before are unchanged", () => {
      const series = buildPortfolioHistory(
        [
          { accountId: "a1", takenAt: 1000, totalUsd: 10 },
          { accountId: "a2", takenAt: 1000, totalUsd: 5 },
          { accountId: "a1", takenAt: 3000, totalUsd: 20 },
        ],
        new Map([["a2", 2000]]),
      );
      expect(series).toEqual([
        { t: 1000, total: 15 }, // before archiving: both count
        { t: 3000, total: 20 }, // after archiving: a2's 5 is no longer carried
      ]);
    });

    it("a point exactly at the archive time already excludes it", () => {
      const series = buildPortfolioHistory(
        [
          { accountId: "a1", takenAt: 1000, totalUsd: 10 },
          { accountId: "a2", takenAt: 1000, totalUsd: 5 },
          { accountId: "a1", takenAt: 2000, totalUsd: 10 },
        ],
        new Map([["a2", 2000]]),
      );
      expect(series[1]).toEqual({ t: 2000, total: 10 });
    });

    // The archived account's own snapshot before archiving still counts at its own time.
    it("an archived account's own pre-archive snapshots still produce points", () => {
      const series = buildPortfolioHistory(
        [
          { accountId: "a1", takenAt: 1000, totalUsd: 10 },
          { accountId: "a2", takenAt: 1500, totalUsd: 5 },
          { accountId: "a1", takenAt: 3000, totalUsd: 10 },
        ],
        new Map([["a2", 2000]]),
      );
      expect(series).toEqual([
        { t: 1000, total: 10 },
        { t: 1500, total: 15 },
        { t: 3000, total: 10 },
      ]);
    });

    it("no archive map = unchanged behaviour, byte for byte", () => {
      const rows = [
        { accountId: "a1", takenAt: 1000, totalUsd: 10 },
        { accountId: "a2", takenAt: 1500, totalUsd: 5 },
        { accountId: "a1", takenAt: 2000, totalUsd: 20 },
      ];
      expect(buildPortfolioHistory(rows)).toEqual(buildPortfolioHistory(rows, new Map()));
    });

    it("after everyone is archived the total is 0, not the last value held", () => {
      const series = buildPortfolioHistory(
        [
          { accountId: "a1", takenAt: 1000, totalUsd: 10 },
          { accountId: "a2", takenAt: 2000, totalUsd: 5 },
        ],
        new Map([
          ["a1", 1500],
          ["a2", 2000],
        ]),
      );
      expect(series).toEqual([
        { t: 1000, total: 10 },
        { t: 2000, total: 0 },
      ]);
    });
  });

  it("handles a single account and empty input", () => {
    expect(buildPortfolioHistory([{ accountId: "a", takenAt: 5, totalUsd: 3 }])).toEqual([
      { t: 5, total: 3 },
    ]);
    expect(buildPortfolioHistory([])).toEqual([]);
  });
});

describe("downsampleSeries", () => {
  const p = (t: number, total: number): HistoryPoint => ({ t, total });

  it("uses hourly buckets when the span is ~1 day", () => {
    // A point every 10 min for a day (144, with intraday spam) → hourly (≤24 points), last per hour kept.
    const dense = Array.from({ length: 144 }, (_, i) => p(i * 10 * 60_000, 100 + i));
    const out = downsampleSeries(dense);
    expect(out.length).toBeLessThanOrEqual(24);
    // Hour 0's last point = the 6th (t=50min, total=105).
    expect(out[0]).toEqual(p(50 * 60_000, 105));
    expect(out.at(-1)).toEqual(dense.at(-1)); // live last point kept
  });

  it("uses daily buckets when the span is ~30 days", () => {
    // 30 days, 4 points a day → daily (≤40 points → 1-day buckets), last per day kept.
    const rows: HistoryPoint[] = [];
    for (let d = 0; d < 30; d++)
      for (let k = 0; k < 4; k++) rows.push(p(d * DAY + k * 6 * HOUR, d * 10 + k));
    const out = downsampleSeries(rows);
    expect(out).toHaveLength(30);
    expect(out[0]).toEqual(p(18 * HOUR, 3)); // day 0's last (k=3)
    expect(out.at(-1)).toEqual(rows.at(-1));
  });

  it("collapses an hour of manual-refresh spam to a single point", () => {
    const spam = Array.from({ length: 12 }, (_, i) => p(i * 5 * 60_000, 100 + i)); // 12 times in one hour
    const out = downsampleSeries(spam);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(p(11 * 5 * 60_000, 111));
  });

  it("passes through 0/1-point input and keeps chronological order", () => {
    expect(downsampleSeries([])).toEqual([]);
    expect(downsampleSeries([p(5, 1)])).toEqual([p(5, 1)]);
  });

  it("honours a bucket floor, so a short span can't fall below it", () => {
    // 6-day span with several syncs on the last day: adaptive picks 4h buckets (6d/4h=36 ≤ 40), splitting that day.
    const rows = [p(0, 10), p(2 * DAY, 20), p(4 * DAY, 30)];
    for (let k = 0; k < 4; k++) rows.push(p(6 * DAY + k * 5 * HOUR, 40 + k));
    expect(downsampleSeries(rows).length).toBeGreaterThan(4); // no floor → last day split
    expect(downsampleSeries(rows, 40, DAY)).toHaveLength(4); // floor → one per day
  });
});

// The Insights X axis labels days only; sub-daily points repeat the same date label (seen: 7 × "Jul 28").
describe("toDailySeries", () => {
  const p = (t: number, total: number): HistoryPoint => ({ t, total });

  it("gives at most one point per day, keeping that day's last value", () => {
    const rows = [
      p(0, 10), // day 0
      p(2 * DAY, 20), // day 2
      p(4 * DAY, 30), // day 4
      p(6 * DAY + 1 * HOUR, 40), // day 6, four syncs that day
      p(6 * DAY + 7 * HOUR, 41),
      p(6 * DAY + 13 * HOUR, 42),
      p(6 * DAY + 19 * HOUR, 43),
    ];
    const out = toDailySeries(rows);

    const days = out.map((x) => Math.floor(x.t / DAY));
    expect(new Set(days).size).toBe(days.length); // no duplicate date ticks
    expect(out).toHaveLength(4);
    expect(out.at(-1)).toEqual(p(6 * DAY + 19 * HOUR, 43)); // that day's close, same source as the home total
  });

  it("leaves an already-daily series alone", () => {
    const rows = [p(0, 1), p(DAY, 2), p(2 * DAY, 3)];
    expect(toDailySeries(rows)).toEqual(rows);
  });
});

// API raw data → the home/insights curve, computed in the browser.
describe("toPortfolioCurve", () => {
  const rows = [
    { accountId: "a1", takenAt: 1000, totalUsd: 10 },
    { accountId: "a2", takenAt: 1500, totalUsd: 5 },
    { accountId: "a1", takenAt: 2000, totalUsd: 20 },
  ];
  const live = (...ids: string[]) => ({ rows, archivedAt: [], liveAccountIds: ids });
  const totals = (...pairs: [string, number][]) => ({
    accountTotals: pairs.map(([id, totalUsd]) => ({ account: { id }, totalUsd })),
  });

  it("last point becomes the live net worth (sum of the overview's per-account totals); others unchanged", () => {
    const curve = toPortfolioCurve(live("a1", "a2"), totals(["a1", 900], ["a2", 99]));

    expect(curve).toEqual([
      { t: 1000, total: 10 },
      { t: 1500, total: 15 },
      { t: 2000, total: 999 }, // frozen value 25, replaced by live net worth
    ]);
  });

  // The curve ignores tab pins but the overview may be narrowed and miss accounts. If any is missing keep
  // the last point frozen: a slightly stale value beats a live value that is mysteriously too low.
  it("overview missing an active account of the curve → last point stays frozen, no wrong number", () => {
    const curve = toPortfolioCurve(live("a1", "a2"), totals(["a1", 900]));

    expect(curve.at(-1)).toEqual({ t: 2000, total: 25 }); // frozen value, not 900
    // Earlier points unchanged — this branch only affects the last point.
    expect(curve.slice(0, -1)).toEqual([
      { t: 1000, total: 10 },
      { t: 1500, total: 15 },
    ]);
  });

  it("extra accounts in the overview don't count — last point sums only the curve's own", () => {
    const curve = toPortfolioCurve(live("a1"), totals(["a1", 900], ["someone-else", 1_000_000]));

    expect(curve.at(-1)).toEqual({ t: 2000, total: 900 });
  });

  it("everyone archived (no active accounts) → last point is 0, not the frozen value", () => {
    const curve = toPortfolioCurve(live(), totals());

    expect(curve.at(-1)).toEqual({ t: 2000, total: 0 });
  });

  it("archive map still works (still a pair array after the JSON trip)", () => {
    const raw = { rows, archivedAt: [["a2", 1800] as [string, number]], liveAccountIds: ["a1"] };
    expect(toPortfolioCurve(raw, totals(["a1", 7])).map((p) => p.total)).toEqual([10, 15, 7]);
    // The middle point precedes a2's archiving so still has its 5; if the pairs weren't read as an archive
    // map it would be 15 and carry a2's ghost value onward.
    const earlier = { ...raw, archivedAt: [["a2", 1200] as [string, number]] };
    expect(toPortfolioCurve(earlier, totals(["a1", 7])).map((p) => p.total)).toEqual([10, 10, 7]);
  });

  // Invariants over seeded random data: last point = Σ live values of the curve's active accounts (frozen if
  // the overview is incomplete) at the last snapshot's time; other points match step rebuild; ascending, no NaN.
  it("random data: last point is live net worth, times ascending, no NaN", () => {
    let seed = 99;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    let replaced = 0;
    let frozen = 0;
    for (let n = 0; n < 400; n++) {
      const ids = Array.from({ length: int(1, 5) }, (_, i) => `a${i}`);
      const rows = Array.from({ length: int(1, 200) }, () => ({
        accountId: ids[int(0, ids.length - 1)],
        takenAt: int(0, 300) * HOUR, // coarse times → many accounts share a time
        totalUsd: int(0, 1_000_000) / 100,
      }));
      const archivedAt: [string, number][] = ids
        .filter(() => rand() < 0.25)
        .map((id) => [id, int(0, 300) * HOUR]);
      const archived = new Set(archivedAt.map(([id]) => id));
      // Active = unarchived, plus occasionally a new account with no snapshot yet.
      const liveAccountIds = [
        ...ids.filter((id) => !archived.has(id)),
        ...(rand() < 0.2 ? ["fresh"] : []),
      ];
      const pool = [...liveAccountIds, ...(rand() < 0.3 ? ["someone-else"] : [])];
      const dropOne = liveAccountIds.length > 0 && rand() < 0.2;
      const covered = dropOne ? pool.filter((id) => id !== liveAccountIds[0]) : pool;
      const accountTotals = covered.map((id) => ({
        account: { id },
        totalUsd: int(0, 1_000_000) / 100,
      }));
      const sampled = rand() < 0.4;
      const raw = { rows, archivedAt, liveAccountIds, sampled };

      const curve = toPortfolioCurve(raw, { accountTotals });
      const rebuilt = buildPortfolioHistory(rows, new Map(archivedAt));

      expect(curve.length).toBeGreaterThan(0);
      for (const p of curve) expect(Number.isFinite(p.total)).toBe(true);
      for (let i = 1; i < curve.length; i++) expect(curve[i].t).toBeGreaterThan(curve[i - 1].t);
      expect(curve.at(-1)?.t).toBe(Math.max(...rows.map((r) => r.takenAt)));
      if (!sampled) expect(curve.slice(0, -1)).toEqual(rebuilt.slice(0, -1));
      const byId = new Map(accountTotals.map((a) => [a.account.id, a.totalUsd]));
      if (dropOne) {
        frozen++;
        expect(curve.at(-1)?.total).toBe(rebuilt.at(-1)?.total);
      } else {
        replaced++;
        let live = 0;
        for (const id of liveAccountIds) live += byId.get(id) ?? Number.NaN;
        expect(curve.at(-1)?.total).toBe(live);
      }
    }
    expect(replaced).toBeGreaterThan(200);
    expect(frozen).toBeGreaterThan(30);
  });

  it("no points → empty curve, no invented live point", () => {
    expect(
      toPortfolioCurve({ rows: [], archivedAt: [], liveAccountIds: ["a1"] }, totals(["a1", 1234])),
    ).toEqual([]);
  });
});
