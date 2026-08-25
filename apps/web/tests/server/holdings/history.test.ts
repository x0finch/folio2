import { beforeEach, describe, expect, it } from "vitest";
import { HoldingHistoryInput, handleGetHoldingHistory } from "@/lib/server/holdings/history";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { DAY, seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// #527 · getHoldingHistory
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

describe("getHoldingHistory", () => {
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

    const { series } = await call(USER, handleGetHoldingHistory({ key: BTC }));

    expect(series).toHaveLength(1);
    expect(series[0].total).toBe(600);
  });

  it("过去的点用当时的快照值,不按今天的价重推", async () => {
    // 冻结口径:两天前那笔值 100,今天同样 1 个币值 500 —— 曲线上第一个点必须还是 100。
    const acc = await seedAccount(USER, "甲");
    await seedSnapshot(USER, acc.id, NOW - 2 * DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 500 }]);

    const { series } = await call(USER, handleGetHoldingHistory({ key: BTC }));

    expect(series.map((p) => p.total)).toEqual([100, 500]);
  });

  it("带 since → 只返回窗口内的点", async () => {
    const acc = await seedAccount(USER, "甲");
    await seedSnapshot(USER, acc.id, NOW - 10 * DAY, [{ tokenId: BTC, amount: 1, usdValue: 10 }]);
    await seedSnapshot(USER, acc.id, NOW - DAY, [{ tokenId: BTC, amount: 1, usdValue: 20 }]);

    const { series } = await call(
      USER,
      handleGetHoldingHistory({ key: BTC, since: NOW - 2 * DAY }),
    );

    expect(series.map((p) => p.total)).toEqual([20]);
  });

  it("key 对不上任何持仓 → 空曲线,不是报错", async () => {
    const acc = await seedAccount(USER, "甲");
    await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

    const { series } = await call(USER, handleGetHoldingHistory({ key: "token-doge" }));

    expect(series).toEqual([]);
  });

  it("窗口里某个账户中途才有快照 → 它之前的点不凭空补 0", async () => {
    // 甲在两天前和现在都有;乙只有现在。两天前那个点应该只有甲的 100,不是 100+0 之后又被
    // 「乙也算一份」拉低成别的数 —— 关键是那个点的值仍然是 100。
    const a = await seedAccount(USER, "甲");
    const b = await seedAccount(USER, "乙");
    await seedSnapshot(USER, a.id, NOW - 2 * DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, a.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, b.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 50 }]);

    const { series } = await call(USER, handleGetHoldingHistory({ key: BTC }));

    expect(series[0].total).toBe(100);
    expect(series.at(-1)?.total).toBe(150);
  });

  it("perp 权益混在同一账户里 → 被排除,不进这条曲线", async () => {
    // 入选口径是 `kind === "spot"`:perp 权益不并入(否则与 Perps 那一栏双算)。
    const acc = await seedAccount(USER, "甲");
    await seedSnapshot(USER, acc.id, NOW, [
      { tokenId: BTC, amount: 1, usdValue: 100 },
      { tokenId: BTC, amount: 1, usdValue: 900, kind: "perp_equity" },
    ]);

    const { series } = await call(USER, handleGetHoldingHistory({ key: BTC }));

    expect(series.at(-1)?.total).toBe(100);
  });

  it("别人的快照不进我的曲线", async () => {
    const theirs = await seedAccount(otherUser(USER), "他们的");
    await seedSnapshot(otherUser(USER), theirs.id, NOW, [
      { tokenId: BTC, amount: 1, usdValue: 999 },
    ]);
    const mine = await seedAccount(USER, "甲");
    await seedSnapshot(USER, mine.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

    const { series } = await call(USER, handleGetHoldingHistory({ key: BTC }));

    expect(series.at(-1)?.total).toBe(100);
  });

  it("key 空串 / since 是负数 → schema 拒", () => {
    expect(HoldingHistoryInput.safeParse({ key: "" }).success).toBe(false);
    expect(HoldingHistoryInput.safeParse({ key: "t", since: -1 }).success).toBe(false);
  });
});
