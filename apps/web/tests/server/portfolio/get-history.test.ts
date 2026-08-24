import { beforeEach, describe, expect, it } from "vitest";
import { handleGetPortfolioHistory } from "@/lib/server/portfolio/get-history";
import { PortfolioSelectInput } from "@/lib/server/portfolio/scope";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { DAY, seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// #527 · getPortfolioHistory
const USER = "h-pf-history";
const BTC = "token-btc";
const ETH = "token-eth";

let NOW = 0;
const ago = (ms: number) => NOW - ms;

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
  NOW = Date.now();
});

describe("getPortfolioHistory", () => {
  it("两个账户各有快照 → 曲线按时间升序", async () => {
    const a = await seedAccount(USER, "甲", "bitcoin");
    const b = await seedAccount(USER, "乙", "binance");
    await seedSnapshot(USER, a.id, ago(3 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, b.id, ago(3 * DAY), [{ tokenId: ETH, amount: 1, usdValue: 50 }]);
    await seedSnapshot(USER, a.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 120 }]);
    await seedSnapshot(USER, b.id, ago(DAY), [{ tokenId: ETH, amount: 1, usdValue: 60 }]);

    const { series } = await call(USER, handleGetPortfolioHistory({}));

    const times = series.map((p) => p.t);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect(series.length).toBeGreaterThanOrEqual(2);
  });

  it("切到只含一个账户的 Portfolio → 曲线只含那一个", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const other = await db(USER).portfolios.create({ name: "另一个" });
    const a = await seedAccount(USER, "甲", "bitcoin");
    const b = await seedAccount(USER, "乙", "binance");
    await db(USER).portfolios.assignAccount(a.id, def.id);
    await db(USER).portfolios.assignAccount(b.id, other.id);
    await seedSnapshot(USER, a.id, ago(2 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, b.id, ago(2 * DAY), [{ tokenId: ETH, amount: 1, usdValue: 900 }]);
    await seedSnapshot(USER, a.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, b.id, ago(DAY), [{ tokenId: ETH, amount: 1, usdValue: 900 }]);

    const { series } = await call(USER, handleGetPortfolioHistory({ portfolioId: other.id }));

    // 只含乙 → 每个点都是 900 那一档,不含甲的 100。
    expect(series.every((p) => p.total >= 900)).toBe(true);
  });

  it("某账户净值为负 → 相加如实,组合曲线可以为负", async () => {
    const a = await seedAccount(USER, "永续", "hyperliquid");
    await seedSnapshot(USER, a.id, ago(2 * DAY), [
      { tokenId: BTC, amount: 1, usdValue: -300, kind: "perp_equity" },
    ]);
    await seedSnapshot(USER, a.id, ago(DAY), [
      { tokenId: BTC, amount: 1, usdValue: -300, kind: "perp_equity" },
    ]);

    const { series } = await call(USER, handleGetPortfolioHistory({}));

    expect(series.length).toBeGreaterThan(0);
    expect(series.some((p) => p.total < 0)).toBe(true);
  });

  it("全新用户 → 空曲线,不报错", async () => {
    const { series } = await call(USER, handleGetPortfolioHistory({}));

    expect(series).toEqual([]);
  });

  it("portfolioId 传别人的 → 退回默认", async () => {
    const theirPf = await db(otherUser(USER)).portfolios.ensureDefault();
    const mine = await seedAccount(USER, "我的", "bitcoin");
    await seedSnapshot(USER, mine.id, ago(2 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, mine.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

    const { series } = await call(USER, handleGetPortfolioHistory({ portfolioId: theirPf.id }));

    expect(series.length).toBeGreaterThan(0);
    expect(series.every((p) => p.total === 100)).toBe(true);
  });

  it("同一小时内同步多次 → 塌缩成一个点,曲线不抖", async () => {
    // 折叠发生在写快照那一层(`collapseSameHour`),这条从读端确认它的效果。
    const a = await seedAccount(USER, "甲", "bitcoin");
    const base = ago(2 * DAY);
    for (const [i, v] of [100, 110, 120, 130, 140].entries()) {
      await db(USER).snapshots.write(
        a.id,
        {
          takenAt: base + i * 60_000,
          totalUsd: v,
          balances: [{ amount: 1, usdValue: v, kind: "spot", tokenId: BTC }],
        },
        { collapseSameHour: true },
      );
    }

    const { series } = await call(USER, handleGetPortfolioHistory({}));

    expect(series).toHaveLength(1);
    expect(series[0].total).toBe(140); // 该钟点最后那一个
  });

  it("入参缺省 → schema 给出默认值", () => {
    expect(PortfolioSelectInput.parse(undefined)).toEqual({});
  });
});
