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
  return tokenValueHistoryFromRaw(raw, input.key);
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

  it("只下发该 token 在窗口内的行", async () => {
    const acc = await seedAccount(USER, "甲");
    await seedSnapshot(USER, acc.id, NOW, [
      { tokenId: BTC, amount: 1, usdValue: 100 },
      { tokenId: "token-eth", amount: 1, usdValue: 50 },
    ]);

    const raw = await call(USER, handleGetTokenValueHistory({ key: BTC }));

    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]?.tokenId).toBe(BTC);
  });

  it("key 空串 / since 是负数 → schema 拒", () => {
    expect(TokenValueHistoryInput.safeParse({ key: "" }).success).toBe(false);
    expect(TokenValueHistoryInput.safeParse({ key: "t", since: -1 }).success).toBe(false);
  });
});
