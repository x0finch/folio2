import { describe, expect, it } from "vitest";
import { downsampleSeries, minMaxDownsampleHistory } from "@/lib/core/history";
import { tokenValueHistoryFromRaw } from "@/lib/core/portfolio";

const H = 3_600_000;

describe("tokenValueHistoryFromRaw", () => {
  it("cross-account step rebuild: value at a moment = Σ of each account's latest row at or before it", () => {
    const s = tokenValueHistoryFromRaw({
      rows: [
        { accountId: "A", takenAt: 100 * H, totalUsd: 10 },
        { accountId: "A", takenAt: 200 * H, totalUsd: 12 },
        { accountId: "B", takenAt: 200 * H, totalUsd: 5 },
        { accountId: "B", takenAt: 300 * H, totalUsd: 6 },
      ],
      sampled: false,
    });
    expect(s).toEqual([
      { t: 100 * H, total: 10 },
      { t: 200 * H, total: 17 },
      { t: 300 * H, total: 18 },
    ]);
  });

  it("short window: rebuild + adaptive downsampling (same rule as the account / overview short window)", () => {
    const rows = Array.from({ length: 48 }, (_, i) => ({
      accountId: "A",
      takenAt: i * H,
      totalUsd: 100 + i,
    }));
    const s = tokenValueHistoryFromRaw({ rows, sampled: false });
    expect(s).toEqual(downsampleSeries(rows.map((r) => ({ t: r.takenAt, total: r.totalUsd }))));
  });

  it("long window: rebuild then min-max downsampling, spikes and troughs both kept", () => {
    const DAY = 86_400_000;
    const rows = Array.from({ length: 200 }, (_, i) => ({
      accountId: "A",
      takenAt: i * DAY,
      totalUsd: i === 77 ? 5000 : i === 133 ? 1 : 100,
    }));
    const s = tokenValueHistoryFromRaw({ rows, sampled: true });
    expect(s.length).toBeLessThanOrEqual(80 + 2);
    const totals = s.map((p) => p.total);
    expect(Math.max(...totals)).toBe(5000);
    expect(Math.min(...totals)).toBe(1);
    expect(s[0]).toEqual({ t: 0, total: 100 });
    expect(s.at(-1)).toEqual({ t: 199 * DAY, total: 100 });
  });

  it("no rows: empty curve", () => {
    expect(tokenValueHistoryFromRaw({ rows: [], sampled: true })).toEqual([]);
  });
});

describe("minMaxDownsampleHistory", () => {
  it("each bucket keeps its min and max, first and last points forced, ascending", () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ t: i, total: Math.sin(i / 10) * 100 }));
    const out = minMaxDownsampleHistory(pts, 20);
    expect(out.length).toBeLessThanOrEqual(20 * 2 + 2);
    expect(out[0]).toEqual(pts[0]);
    expect(out.at(-1)).toEqual(pts.at(-1));
    expect(Math.max(...out.map((p) => p.total))).toBe(Math.max(...pts.map((p) => p.total)));
    expect(Math.min(...out.map((p) => p.total))).toBe(Math.min(...pts.map((p) => p.total)));
    const ts = out.map((p) => p.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("random series: extremes and first/last points kept, no invented points, ascending, point count bounded", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let n = 0; n < 500; n++) {
      const len = 2 + Math.floor(rand() * 300);
      const buckets = 2 + Math.floor(rand() * 60);
      let t = Math.floor(rand() * 1e12);
      let v = rand() * 1e5;
      const pts: { t: number; total: number }[] = [];
      for (let i = 0; i < len; i++) {
        t += 1 + Math.floor(rand() * (rand() < 0.1 ? 1e9 : 1e6));
        const r = rand();
        v = r < 0.2 ? v : r < 0.25 ? v * (rand() < 0.5 ? 0.3 : 3) : v + (rand() - 0.5) * 1e3;
        pts.push({ t, total: Math.round(v * 100) / 100 });
      }
      const input = rand() < 0.3 ? [...pts].sort(() => rand() - 0.5) : pts;
      const out = minMaxDownsampleHistory(input, buckets);
      const totals = (xs: { total: number }[]) => xs.map((p) => p.total);

      expect(out.length).toBeLessThanOrEqual(2 * buckets + 2);
      expect(Math.max(...totals(out))).toBe(Math.max(...totals(pts)));
      expect(Math.min(...totals(out))).toBe(Math.min(...totals(pts)));
      expect(out[0]).toBe(pts[0]);
      expect(out.at(-1)).toBe(pts.at(-1));
      const inputs = new Set(pts);
      expect(out.every((p) => inputs.has(p))).toBe(true);
      for (let i = 1; i < out.length; i++) expect(out[i].t).toBeGreaterThan(out[i - 1].t);
    }
  });

  it("≤ 1 point / all at the same instant: unchanged", () => {
    expect(minMaxDownsampleHistory([])).toEqual([]);
    expect(minMaxDownsampleHistory([{ t: 1, total: 2 }])).toEqual([{ t: 1, total: 2 }]);
    expect(
      minMaxDownsampleHistory([
        { t: 1, total: 2 },
        { t: 1, total: 3 },
      ]),
    ).toEqual([{ t: 1, total: 2 }]);
  });
});
