import { beforeEach, describe, expect, it } from "vitest";
import { handleGetAccountGain24h, handleGetPortfolioGain24h } from "@/lib/server/portfolio/gain";
import { handleGetPortfolioOverview } from "@/lib/server/portfolio/overview";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { DAY, seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolio/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolio/gain", () => {
  // #527 · getPortfolioGain24h / getAccountGain24h
  //
  // 窗口是 24 小时,基准点允许偏离窗口起点 ±2 小时(快照是稀疏的,不会正好落在那一刻)。
  // 所以「有基准」的场景要把旧快照放在 24h 前附近,「没基准」的场景放在远得多的地方。
  const USER = "h-pf-gain";
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

  describe("getPortfolioGain24h", () => {
    it("窗口起点附近有基准 → 组合级那个数 = 各持仓行相加", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(DAY), [
        { tokenId: BTC, amount: 1, usdValue: 100 },
        { tokenId: ETH, amount: 1, usdValue: 50 },
      ]);
      await seedSnapshot(USER, acc.id, NOW, [
        { tokenId: BTC, amount: 1, usdValue: 130 },
        { tokenId: ETH, amount: 1, usdValue: 60 },
      ]);

      const out = await call(USER, handleGetPortfolioGain24h({}));

      const rows = Object.values(out.holdings).filter((g) => g != null);
      expect(rows).toHaveLength(2);
      const sum = rows.reduce((s, g) => s + (g?.amount ?? 0), 0);
      expect(out.portfolio?.amount).toBeCloseTo(sum, 6);
    });

    it("缺 24 小时前的基准 → 给 null,不给 0", async () => {
      // 唯一那张快照在 10 天前 —— 窗口起点附近什么都没有,算不出。
      // 0 会被读成「没涨没跌」,那是在断言一件我们不知道的事。
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(10 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const out = await call(USER, handleGetPortfolioGain24h({}));

      for (const g of Object.values(out.holdings)) expect(g).toBeNull();
      expect(out.portfolio).toBeNull();
    });

    it("现值为负的那一行 → 留在列表里,总额和明细对得上(#527 发现 2,已修)", async () => {
      // 原来 `totalValue <= 0` 把负合计行连同 0 值行一起剔了,而 totalUsd 一直算着它 ——
      // 屏幕上就是「净值少了 50,列表里没有一行能解释」。判据改成「=== 0」:0 值垃圾照剔,
      // 负值真仓留下。
      const acc = await seedAccount(USER, "永续", "hyperliquid");
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: -50 }]);

      const view = await call(USER, handleGetPortfolioOverview({}));

      expect(view.totalUsd).toBe(-50);
      expect(view.holdings.map((h) => h.key)).toContain(BTC); // 列表里有它,能解释总额
      expect(view.holdings.find((h) => h.key === BTC)?.totalValue).toBe(-50);
    });

    it("归档账户 → 不进这个结果", async () => {
      const live = await seedAccount(USER, "在用", "bitcoin");
      await seedSnapshot(USER, live.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, live.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 110 }]);
      const archived = await seedAccount(USER, "归档", "bitcoin");
      await seedSnapshot(USER, archived.id, ago(DAY), [{ tokenId: ETH, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, archived.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 900 }]);
      await db(USER).accounts.setArchived(archived.id, true);

      const out = await call(USER, handleGetPortfolioGain24h({}));

      expect(Object.keys(out.holdings)).toHaveLength(1);
    });

    it("同一个币在两个账户各有仓 → 字典 key 不撞,合并成一条", async () => {
      const a = await seedAccount(USER, "甲", "bitcoin");
      const b = await seedAccount(USER, "乙", "binance");
      for (const acc of [a, b]) {
        await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
        await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 120 }]);
      }

      const out = await call(USER, handleGetPortfolioGain24h({}));

      expect(Object.keys(out.holdings)).toHaveLength(1);
      expect(Object.keys(out.holdings)[0]).toBe(BTC);
    });

    it("全新用户 → 三个字段都空,不报错", async () => {
      const out = await call(USER, handleGetPortfolioGain24h({}));

      expect(out.portfolio).toBeNull();
      expect(out.holdings).toEqual({});
      expect(out.defi).toEqual({});
    });

    it("portfolioId 传别人的 → 退回默认,别人的数据不出现", async () => {
      const theirPf = await db(otherUser(USER)).portfolios.ensureDefault();
      const theirAcc = await seedAccount(otherUser(USER), "他们的", "bitcoin");
      await seedSnapshot(otherUser(USER), theirAcc.id, ago(DAY), [
        { tokenId: ETH, amount: 1, usdValue: 100 },
      ]);
      await seedSnapshot(otherUser(USER), theirAcc.id, NOW, [
        { tokenId: ETH, amount: 1, usdValue: 999 },
      ]);
      const mine = await seedAccount(USER, "我的", "bitcoin");
      await seedSnapshot(USER, mine.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, mine.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 110 }]);

      const out = await call(USER, handleGetPortfolioGain24h({ portfolioId: theirPf.id }));

      expect(Object.keys(out.holdings)).toEqual([BTC]);
    });
  });

  describe("getAccountGain24h", () => {
    it("账户级那个数 = 它各余额行相加", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(DAY), [
        { tokenId: BTC, amount: 1, usdValue: 100 },
        { tokenId: ETH, amount: 1, usdValue: 50 },
      ]);
      await seedSnapshot(USER, acc.id, NOW, [
        { tokenId: BTC, amount: 1, usdValue: 130 },
        { tokenId: ETH, amount: 1, usdValue: 60 },
      ]);

      const out = await call(USER, handleGetAccountGain24h());

      const rows = Object.values(out.balances).filter((g) => g != null);
      const sum = rows.reduce((s, g) => s + (g?.amount ?? 0), 0);
      expect(out.accounts[acc.id]?.amount).toBeCloseTo(sum, 6);
    });

    it("归档账户 → 账户级和余额级都不出现", async () => {
      const archived = await seedAccount(USER, "归档", "bitcoin");
      await seedSnapshot(USER, archived.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, archived.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 900 }]);
      await db(USER).accounts.setArchived(archived.id, true);

      const out = await call(USER, handleGetAccountGain24h());

      expect(out.accounts[archived.id]).toBeUndefined();
      expect(Object.keys(out.balances)).toEqual([]);
    });

    it("算不出的账户 → 给 null,不给 0", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(10 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const out = await call(USER, handleGetAccountGain24h());

      expect(out.accounts[acc.id]).toBeNull();
    });

    it("全新用户 → 两个字典都是空的", async () => {
      const out = await call(USER, handleGetAccountGain24h());

      expect(out.accounts).toEqual({});
      expect(out.balances).toEqual({});
    });
  });
});
