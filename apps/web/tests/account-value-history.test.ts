import { describe, expect, it } from "vitest";
import { buildAccountValueHistory } from "@/lib/core/history";

// Single-account value history: snapshots (takenAt, totalUsd) → ascending points; the last point equals the
// account's current totalUsd. Tests use day spacing so downsampleSeries' hourly buckets don't merge points.
const DAY = 86_400_000;

describe("buildAccountValueHistory", () => {
  it("multiple snapshots → ascending, each total = the account total at that time", () => {
    const s = buildAccountValueHistory([
      { takenAt: 3 * DAY, totalUsd: 130 },
      { takenAt: 1 * DAY, totalUsd: 100 },
      { takenAt: 2 * DAY, totalUsd: 120 },
    ]);
    expect(s.map((p) => [p.t, p.total])).toEqual([
      [1 * DAY, 100],
      [2 * DAY, 120],
      [3 * DAY, 130],
    ]);
  });

  it("fewer than 2 points → returned as-is (caller skips the chart below 2)", () => {
    expect(buildAccountValueHistory([{ takenAt: 1 * DAY, totalUsd: 100 }])).toEqual([
      { t: 1 * DAY, total: 100 },
    ]);
    expect(buildAccountValueHistory([])).toEqual([]);
  });
});

// Only unarchived manual accounts carry a "now" point, valued at current prices like the sheet header.
describe("buildAccountValueHistory now-point", () => {
  const rows = [
    { takenAt: 1 * DAY, totalUsd: 100 },
    { takenAt: 2 * DAY, totalUsd: 120 },
  ];

  it("now-point not after the last point → replaces its value, no extra point", () => {
    const s = buildAccountValueHistory(rows, { t: 2 * DAY, total: 175 });
    expect(s).toEqual([
      { t: 1 * DAY, total: 100 },
      { t: 2 * DAY, total: 175 },
    ]);
  });

  it("later now-point → appended", () => {
    const s = buildAccountValueHistory(rows, { t: 5 * DAY, total: 175 });
    expect(s.at(-1)).toEqual({ t: 5 * DAY, total: 175 });
    expect(s).toHaveLength(3);
  });

  it("empty account gets no invented point — same as the snapshot path", () => {
    expect(buildAccountValueHistory([], { t: 5 * DAY, total: 175 })).toEqual([]);
  });

  it("no now-point (snapshot account / archived) → last point is the frozen value of the last sync", () => {
    expect(buildAccountValueHistory(rows, null).at(-1)).toEqual({
      t: 2 * DAY,
      total: 120,
    });
  });
});
