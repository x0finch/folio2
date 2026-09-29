import { describe, expect, it } from "vitest";
import { downsampleSeries, minMaxDownsampleHistory } from "@/lib/core/history";
import { tokenValueHistoryFromRaw } from "@/lib/core/portfolio";

// 单币价值曲线的浏览器那一半(FOL-92):归属与「只数现货」、每快照合计已在 SQL 里做完
// (`packages/db` 的 `listTokenValueTotals`,那边的用例钉着),这里拿到的是每账户的 (时刻, 价值)。

const H = 3_600_000;

describe("tokenValueHistoryFromRaw", () => {
  it("跨账户阶梯重建:某时刻 = Σ 各账户 ≤该刻最近一行", () => {
    const s = tokenValueHistoryFromRaw({
      rows: [
        { accountId: "A", takenAt: 100 * H, totalUsd: 10 },
        { accountId: "A", takenAt: 200 * H, totalUsd: 12 },
        { accountId: "B", takenAt: 200 * H, totalUsd: 5 },
        { accountId: "B", takenAt: 300 * H, totalUsd: 6 },
      ],
      sampled: false,
    });
    // t100: A=10;t200(同刻并入):A=12,B=5→17;t300:A=12(沿用)+B=6→18
    expect(s).toEqual([
      { t: 100 * H, total: 10 },
      { t: 200 * H, total: 17 },
      { t: 300 * H, total: 18 },
    ]);
  });

  it("短窗:重建 + 自适应降采样(与账户/总览短窗同口径)", () => {
    const rows = Array.from({ length: 48 }, (_, i) => ({
      accountId: "A",
      takenAt: i * H,
      totalUsd: 100 + i,
    }));
    const s = tokenValueHistoryFromRaw({ rows, sampled: false });
    expect(s).toEqual(downsampleSeries(rows.map((r) => ({ t: r.takenAt, total: r.totalUsd }))));
  });

  it("长窗:重建之后 min-max 降采样,尖峰与深谷都在", () => {
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

  it("没有行 → 空曲线", () => {
    expect(tokenValueHistoryFromRaw({ rows: [], sampled: true })).toEqual([]);
  });
});

describe("minMaxDownsampleHistory", () => {
  it("每桶留最低与最高,首末点强制保留,升序", () => {
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

  it("≤ 1 个点 / 全在同一刻 → 原样", () => {
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
