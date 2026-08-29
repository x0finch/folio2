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

  // 归档 = 封存(ADR 0039):账户在归档那一刻之后不再贡献,之前的点原样保留。
  //
  // 这组测的是阶梯重建那个「最后一个值一直保持下去」的性质在归档面前的行为 —— 不截断的话,
  // 归档账户冻住的值会跟着曲线走到今天,而当下点(实时覆写)只算活跃账户,两边就对不上。
  describe("归档成员的贡献止于归档时刻", () => {
    it("归档之后的点不再含它,归档之前的点不变", () => {
      const series = buildPortfolioHistory(
        [
          { accountId: "a1", takenAt: 1000, totalUsd: 10 },
          { accountId: "a2", takenAt: 1000, totalUsd: 5 },
          { accountId: "a1", takenAt: 3000, totalUsd: 20 },
        ],
        new Map([["a2", 2000]]),
      );
      expect(series).toEqual([
        { t: 1000, total: 15 }, // 归档前:两个都算
        { t: 3000, total: 20 }, // 归档后:a2 的 5 不再被保持下去
      ]);
    });

    it("恰好落在归档时刻的点已经不算它", () => {
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

    // 归档账户自己那条快照落在归档之前 → 它在自己的时刻仍然算数,只是之后不再被保持。
    it("归档账户在归档前的自有快照照常成点", () => {
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

    it("不传归档表 = 旧行为,一个字节都不变", () => {
      const rows = [
        { accountId: "a1", takenAt: 1000, totalUsd: 10 },
        { accountId: "a2", takenAt: 1500, totalUsd: 5 },
        { accountId: "a1", takenAt: 2000, totalUsd: 20 },
      ];
      expect(buildPortfolioHistory(rows)).toEqual(buildPortfolioHistory(rows, new Map()));
    });

    it("全员归档之后是 0,不是把最后的值挂在那儿", () => {
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
    // 一天里每 10 分钟一个点(144 个,含日内 spam)→ 应压成小时级(≤24 点),每小时留最后一个。
    const dense = Array.from({ length: 144 }, (_, i) => p(i * 10 * 60_000, 100 + i));
    const out = downsampleSeries(dense);
    expect(out.length).toBeLessThanOrEqual(24);
    // 第 0 小时的最后一个点 = 第 5 个(t=50min, total=105)。
    expect(out[0]).toEqual(p(50 * 60_000, 105));
    expect(out.at(-1)).toEqual(dense.at(-1)); // live 末点保留
  });

  it("uses daily buckets when the span is ~30 days", () => {
    // 30 天、每天 4 个点 → 应压成日级(≤40 点 → 落到 1 天桶),每天留最后一个。
    const rows: HistoryPoint[] = [];
    for (let d = 0; d < 30; d++)
      for (let k = 0; k < 4; k++) rows.push(p(d * DAY + k * 6 * HOUR, d * 10 + k));
    const out = downsampleSeries(rows);
    expect(out).toHaveLength(30);
    expect(out[0]).toEqual(p(18 * HOUR, 3)); // day 0 的最后一个(k=3)
    expect(out.at(-1)).toEqual(rows.at(-1));
  });

  it("collapses an hour of manual-refresh spam to a single point", () => {
    const spam = Array.from({ length: 12 }, (_, i) => p(i * 5 * 60_000, 100 + i)); // 同一小时 12 次
    const out = downsampleSeries(spam);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(p(11 * 5 * 60_000, 111));
  });

  it("passes through 0/1-point input and keeps chronological order", () => {
    expect(downsampleSeries([])).toEqual([]);
    expect(downsampleSeries([p(5, 1)])).toEqual([p(5, 1)]);
  });

  it("honours a bucket floor, so a short span can't fall below it", () => {
    // 6 天跨度 + 末日多次同步:自适应会挑 4 小时桶(6d/4h=36 ≤ 40),末日就散成好几个点。
    const rows = [p(0, 10), p(2 * DAY, 20), p(4 * DAY, 30)];
    for (let k = 0; k < 4; k++) rows.push(p(6 * DAY + k * 5 * HOUR, 40 + k));
    expect(downsampleSeries(rows).length).toBeGreaterThan(4); // 无下限 → 末日拆开
    expect(downsampleSeries(rows, 40, DAY)).toHaveLength(4); // 有下限 → 每天一个
  });
});

// Insights 的 X 轴只标到「日」。粒度细于一天时,同一天的多个点会各占一个刻度,
// 于是轴上连着印出同一个日期 —— 实际见过 7 个 "Jul 28"。
describe("toDailySeries", () => {
  const p = (t: number, total: number): HistoryPoint => ({ t, total });

  it("gives at most one point per day, keeping that day's last value", () => {
    const rows = [
      p(0, 10), // day 0
      p(2 * DAY, 20), // day 2
      p(4 * DAY, 30), // day 4
      p(6 * DAY + 1 * HOUR, 40), // day 6,同日四次同步
      p(6 * DAY + 7 * HOUR, 41),
      p(6 * DAY + 13 * HOUR, 42),
      p(6 * DAY + 19 * HOUR, 43),
    ];
    const out = toDailySeries(rows);

    const days = out.map((x) => Math.floor(x.t / DAY));
    expect(new Set(days).size).toBe(days.length); // 没有重复的日期刻度
    expect(out).toHaveLength(4);
    expect(out.at(-1)).toEqual(p(6 * DAY + 19 * HOUR, 43)); // 当天收盘值,与主页总额同源
  });

  it("leaves an already-daily series alone", () => {
    const rows = [p(0, 1), p(DAY, 2), p(2 * DAY, 3)];
    expect(toDailySeries(rows)).toEqual(rows);
  });
});

// 接口发的原料 → 首页/洞察页那条曲线(FOL-38)。以前这一段在服务端,现在在浏览器里跑。
describe("toPortfolioCurve", () => {
  const rows = [
    { accountId: "a1", takenAt: 1000, totalUsd: 10 },
    { accountId: "a2", takenAt: 1500, totalUsd: 5 },
    { accountId: "a1", takenAt: 2000, totalUsd: 20 },
  ];

  it("末点换成实时总额,其余点原样", () => {
    const curve = toPortfolioCurve({ rows, archivedAt: [] }, 999);

    expect(curve).toEqual([
      { t: 1000, total: 10 },
      { t: 1500, total: 15 },
      { t: 2000, total: 999 }, // 冻结值是 25,被主页那个数顶替
    ]);
  });

  it("归档时刻表照样管用(过了 JSON 那一趟仍是 pair 数组)", () => {
    const curve = toPortfolioCurve({ rows, archivedAt: [["a2", 1800]] }, 7);

    expect(curve.map((p) => p.total)).toEqual([10, 15, 7]);
    // 中间那个点在 a2 归档之前,仍含它的 5;这条钉住 pair 数组真的被读成了归档表 ——
    // 读丢的话它会变成 15 之后一路带着 a2 的幽灵值。
    expect(toPortfolioCurve({ rows, archivedAt: [["a2", 1200]] }, 7).map((p) => p.total)).toEqual([
      10, 10, 7,
    ]);
  });

  it("一个点都没有 → 空曲线,不凭空造一个当下点", () => {
    expect(toPortfolioCurve({ rows: [], archivedAt: [] }, 1234)).toEqual([]);
  });
});
