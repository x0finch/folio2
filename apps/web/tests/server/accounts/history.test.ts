import { beforeEach, describe, expect, it } from "vitest";
import { AccountHistoryInput, handleGetAccountHistory } from "@/lib/server/accounts/history";
import { handleUpdateAccount } from "@/lib/server/accounts/update";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { DAY, seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// #527 · getAccountHistory
const USER = "h-acc-history";
const BTC = "token-btc";

let NOW = 0;
const ago = (ms: number) => NOW - ms;

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
  NOW = Date.now();
});

describe("getAccountHistory", () => {
  it("多张快照 → 曲线按时间升序", async () => {
    const acc = await seedAccount(USER, "甲", "bitcoin");
    for (const [d, v] of [
      [3, 100],
      [2, 120],
      [1, 150],
    ] as const) {
      await seedSnapshot(USER, acc.id, ago(d * DAY), [{ tokenId: BTC, amount: 1, usdValue: v }]);
    }

    const { series } = await call(USER, handleGetAccountHistory({ accountId: acc.id }));

    const times = series.map((p) => p.t);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect(series.map((p) => p.total)).toEqual([100, 120, 150]);
  });

  it("带 since → 更早的点不返回", async () => {
    const acc = await seedAccount(USER, "甲", "bitcoin");
    await seedSnapshot(USER, acc.id, ago(10 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 10 }]);
    await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 20 }]);

    const { series } = await call(
      USER,
      handleGetAccountHistory({ accountId: acc.id, since: ago(2 * DAY) }),
    );

    expect(series.map((p) => p.total)).toEqual([20]);
  });

  it("手记账户 → 曲线由账本算出,末点是按当前价的实时值", async () => {
    const acc = await seedManualAccount(USER, "手记", {
      symbol: "BTC",
      unitPrice: 100,
      amount: 2,
    });

    const { series } = await call(
      USER,
      handleGetAccountHistory({ accountId: acc.id, connectorId: "manual" }),
    );

    expect(series.length).toBeGreaterThan(0);
    expect(series.at(-1)?.t).toBeGreaterThanOrEqual(ago(DAY));
  });

  it("已归档的手记账户 → 末点停在封存时刻,不补实时点", async () => {
    const acc = await seedManualAccount(USER, "手记", {
      symbol: "BTC",
      unitPrice: 100,
      amount: 2,
    });
    await call(USER, handleUpdateAccount({ accountId: acc.id, archived: true }));
    const archivedAt = (await db(USER).accounts.getById(acc.id))?.archivedAt ?? 0;

    const { series } = await call(
      USER,
      handleGetAccountHistory({ accountId: acc.id, connectorId: "manual" }),
    );

    expect(series.at(-1)?.t).toBeLessThanOrEqual(archivedAt);
  });

  it("只有一张快照 → 返回单点,调用方据此说「再同步一次」", async () => {
    const acc = await seedAccount(USER, "甲", "bitcoin");
    await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

    const { series } = await call(USER, handleGetAccountHistory({ accountId: acc.id }));

    expect(series).toHaveLength(1);
  });

  it("从没同步过 → 空曲线,不报错", async () => {
    const acc = await seedAccount(USER, "甲", "bitcoin");

    const { series } = await call(USER, handleGetAccountHistory({ accountId: acc.id }));

    expect(series).toEqual([]);
  });

  it("历史里有负值点(perp 亏穿)→ 原样返回,曲线跨 0 不失真", async () => {
    const acc = await seedAccount(USER, "永续", "hyperliquid");
    await seedSnapshot(USER, acc.id, ago(2 * DAY), [
      { tokenId: BTC, amount: 1, usdValue: 100, kind: "perp_equity" },
    ]);
    await seedSnapshot(USER, acc.id, ago(DAY), [
      { tokenId: BTC, amount: 1, usdValue: -50, kind: "perp_equity" },
    ]);

    const { series } = await call(USER, handleGetAccountHistory({ accountId: acc.id }));

    expect(series.map((p) => p.total)).toEqual([100, -50]);
  });

  it("同一小时内同步五次 → 塌缩成一个点", async () => {
    const acc = await seedAccount(USER, "甲", "bitcoin");
    const base = ago(2 * DAY);
    for (const [i, v] of [100, 110, 120, 130, 140].entries()) {
      await db(USER).snapshots.write(
        acc.id,
        {
          takenAt: base + i * 60_000,
          totalUsd: v,
          balances: [{ amount: 1, usdValue: v, kind: "spot", tokenId: BTC }],
        },
        { collapseSameHour: true },
      );
    }

    const { series } = await call(USER, handleGetAccountHistory({ accountId: acc.id }));

    expect(series).toHaveLength(1);
    expect(series[0].total).toBe(140);
  });

  it("since 传未来的时间戳 → 空曲线,不是报错", async () => {
    const acc = await seedAccount(USER, "甲", "bitcoin");
    await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

    const { series } = await call(
      USER,
      handleGetAccountHistory({ accountId: acc.id, since: NOW + 30 * DAY }),
    );

    expect(series).toEqual([]);
  });

  it("别人的账户 → 拒", async () => {
    const theirs = await seedAccount(otherUser(USER), "他们的", "bitcoin");
    await seedSnapshot(otherUser(USER), theirs.id, ago(DAY), [
      { tokenId: BTC, amount: 1, usdValue: 999 },
    ]);

    const exit = await callExit(USER, handleGetAccountHistory({ accountId: theirs.id }));

    expect(exit._tag).toBe("Failure");
  });

  it("accountId 空串 / since 是负数 → schema 拒", () => {
    expect(AccountHistoryInput.safeParse({ accountId: "" }).success).toBe(false);
    expect(AccountHistoryInput.safeParse({ accountId: "a", since: -1 }).success).toBe(false);
  });
});
