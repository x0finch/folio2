import { beforeEach, describe, expect, it } from "vitest";
import { tokenValueHistoryFromRaw } from "@/lib/core/portfolio";
import { handleGetTokenValueHistory, TokenValueHistoryInput } from "@/lib/server/holdings/history";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { DAY, seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// #527 · getTokenValueHistory (FOL-50)
//
// 这条曲线的归属键就是 tokenId(`groupKey` = `row.tokenId ?? …`),入选口径是 `kind === "spot"`。
const USER = "h-holdings-history";
const BTC = "token-btc";
const NOW = 1_770_000_000_000; // 固定时钟:这一片全是时间关系,不能让墙钟参与

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
});

const curve = async (input: { key: string; since?: number }) => {
  const raw = await call(USER, handleGetTokenValueHistory(input));
  return tokenValueHistoryFromRaw(raw);
};

describe("getTokenValueHistory", () => {
  it("同一个币分散在三个账户 → 每个时刻是三个账户之和", async () => {
    const a = await seedAccount(USER, "甲");
    const b = await seedAccount(USER, "乙");
    const c = await seedAccount(USER, "丙");
    for (const [acc, value] of [
      [a, 100],
      [b, 200],
      [c, 300],
    ] as const) {
      await seedSnapshot(USER, acc.id, NOW - DAY, [{ tokenId: BTC, amount: 1, usdValue: value }]);
    }

    const series = await curve({ key: BTC });

    expect(series).toHaveLength(1);
    expect(series[0].total).toBe(600);
  });

  it("带 since → 只返回窗口内的点", async () => {
    const acc = await seedAccount(USER, "甲");
    await seedSnapshot(USER, acc.id, NOW - 10 * DAY, [{ tokenId: BTC, amount: 1, usdValue: 10 }]);
    await seedSnapshot(USER, acc.id, NOW - DAY, [{ tokenId: BTC, amount: 1, usdValue: 20 }]);

    const series = await curve({ key: BTC, since: NOW - 2 * DAY });

    expect(series.map((p) => p.total)).toEqual([20]);
  });

  it("key 对不上任何持仓 → 空曲线,不是报错", async () => {
    const acc = await seedAccount(USER, "甲");
    await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

    const series = await curve({ key: "token-doge" });

    expect(series).toEqual([]);
  });

  it("别人的快照不进我的曲线", async () => {
    const theirs = await seedAccount(otherUser(USER), "他们的");
    await seedSnapshot(otherUser(USER), theirs.id, NOW, [
      { tokenId: BTC, amount: 1, usdValue: 999 },
    ]);
    const mine = await seedAccount(USER, "甲");
    await seedSnapshot(USER, mine.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

    const series = await curve({ key: BTC });

    expect(series.at(-1)?.total).toBe(100);
  });

  it("短窗:只下发该 token 的现货合计(每账户每天一行),不发余额行", async () => {
    const acc = await seedAccount(USER, "甲");
    await seedSnapshot(USER, acc.id, NOW, [
      { tokenId: BTC, amount: 1, usdValue: 100 },
      { tokenId: BTC, amount: 1, usdValue: 11, kind: "defi" },
      { tokenId: "token-eth", amount: 1, usdValue: 50 },
    ]);

    const raw = await call(USER, handleGetTokenValueHistory({ key: BTC, range: "30d" }));

    expect(raw.sampled).toBe(false);
    expect(raw.rows).toEqual([{ accountId: acc.id, takenAt: NOW, totalUsd: 100 }]);
  });

  it("长窗(all):SQL 按桶封顶(行数与历史长度脱钩),浏览器 min-max 后极值原样", async () => {
    const acc = await seedAccount(USER, "甲");
    // 400 天、每天一张 → 原样是 400 行;长窗每账户 ≤ 3 × 100 + 1 = 301 行(review #2)。
    for (let i = 0; i < 400; i++) {
      await seedSnapshot(USER, acc.id, NOW - i * DAY, [
        { tokenId: BTC, amount: 1, usdValue: 100 + (i % 7) * 10 },
      ]);
    }

    const raw = await call(USER, handleGetTokenValueHistory({ key: BTC, range: "all" }));

    expect(raw.sampled).toBe(true);
    expect(raw.rows.length).toBeGreaterThan(0);
    expect(raw.rows.length).toBeLessThanOrEqual(301);
    const series = tokenValueHistoryFromRaw(raw);
    expect(series.length).toBeLessThanOrEqual(82);
    expect(Math.min(...series.map((p) => p.total))).toBe(100);
    expect(Math.max(...series.map((p) => p.total))).toBe(160);
    // 末点是最后一张快照(i = 0 → 100)。
    expect(series.at(-1)).toEqual({ t: NOW, total: 100 });
  }, 120_000);

  it("key 空串 / since 是负数 → schema 拒", () => {
    expect(TokenValueHistoryInput.safeParse({ key: "" }).success).toBe(false);
    expect(TokenValueHistoryInput.safeParse({ key: "t", since: -1 }).success).toBe(false);
  });
});
