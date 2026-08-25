import { beforeEach, describe, expect, it } from "vitest";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { handleGetPortfolioOverview } from "@/lib/server/portfolio/overview";
import { PortfolioScopeInput } from "@/lib/server/portfolio/scope";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolio/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolio/overview", () => {
  // #527 · getPortfolioOverview
  const USER = "h-pf-overview";
  const BTC = "token-btc";
  const ETH = "token-eth";

  let NOW = 0;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    NOW = Date.now();
  });

  describe("getPortfolioOverview", () => {
    it("三个账户各有仓 → 同一个币合并成一行,金额是各账户之和", async () => {
      for (const [label, value] of [
        ["甲", 100],
        ["乙", 200],
        ["丙", 300],
      ] as const) {
        const acc = await seedAccount(USER, label, "bitcoin");
        await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: value }]);
      }

      const view = await call(USER, handleGetPortfolioOverview({}));

      expect(view.holdings).toHaveLength(1);
      expect(view.holdings[0].totalValue).toBe(600);
      expect(view.totalUsd).toBe(600);
    });

    it("两个不同的币 → 两行,各自独立", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, NOW, [
        { tokenId: BTC, amount: 1, usdValue: 100 },
        { tokenId: ETH, amount: 2, usdValue: 50 },
      ]);

      const view = await call(USER, handleGetPortfolioOverview({}));

      expect(view.holdings).toHaveLength(2);
      expect(view.totalUsd).toBe(150);
    });

    it("手记账户与链上账户持有同一个币 → 合并成一行,来源两条", async () => {
      // **合并的键是 tokenId,不是 symbol。** 所以这个场景必须让两边指向同一行代币 ——
      // 先建手记账户(它经 mint 建出真代币行),读出那个 id,再拿它去种链上那张快照。
      // 第一版我图省事用了一个自造的 tokenId 字符串,两边自然合不到一起 —— 那是夹具的错,
      // 不是产品的错,而这个区别正是这条用例要保护的:哪天合并改回按 symbol,这条会红。
      const manual = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50,
        amount: 2,
      });
      const detail = await call(USER, handleGetManualAccount({ accountId: manual.id }));
      const mintedBtc = detail.tokens[0].id;

      const chain = await seedAccount(USER, "链上", "bitcoin");
      await seedSnapshot(USER, chain.id, NOW, [{ tokenId: mintedBtc, amount: 1, usdValue: 100 }]);

      const view = await call(USER, handleGetPortfolioOverview({}));

      const btcRow = view.holdings.find((h) => (h.totalAmount ?? 0) >= 3);
      expect(btcRow).toBeDefined();
      expect(btcRow?.sources.length).toBeGreaterThanOrEqual(2);
    });

    it("perp 亏穿、净值为负 → 总额如实为负,不被夹成 0", async () => {
      const acc = await seedAccount(USER, "永续", "hyperliquid");
      await seedSnapshot(USER, acc.id, NOW, [
        { tokenId: "token-perp", amount: 1, usdValue: -500, kind: "perp_equity" },
      ]);

      const view = await call(USER, handleGetPortfolioOverview({}));

      expect(view.totalUsd).toBe(-500);
    });

    it("带 pin 按 connector 收窄 → 只算那个上游的账户", async () => {
      const btcAcc = await seedAccount(USER, "链上", "bitcoin");
      await seedSnapshot(USER, btcAcc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      const cexAcc = await seedAccount(USER, "交易所", "binance");
      await seedSnapshot(USER, cexAcc.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 900 }]);

      const view = await call(
        USER,
        handleGetPortfolioOverview({ pin: { kind: "connector", connectorId: "bitcoin" } }),
      );

      expect(view.totalUsd).toBe(100);
    });

    it("portfolioId 传别人的 → 静默退回默认视图,一条别人的数据都不出现", async () => {
      const theirPf = await db(otherUser(USER)).portfolios.ensureDefault();
      const theirAcc = await seedAccount(otherUser(USER), "他们的", "bitcoin");
      await seedSnapshot(otherUser(USER), theirAcc.id, NOW, [
        { tokenId: BTC, amount: 1, usdValue: 999 },
      ]);
      const mine = await seedAccount(USER, "我的", "bitcoin");
      await seedSnapshot(USER, mine.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const view = await call(USER, handleGetPortfolioOverview({ portfolioId: theirPf.id }));

      expect(view.totalUsd).toBe(100);
    });

    it("全新用户 → 空但结构完整的视图,不是报错", async () => {
      const view = await call(USER, handleGetPortfolioOverview({}));

      expect(view.holdings).toEqual([]);
      expect(view.sections).toEqual([]);
      expect(view.totalUsd).toBe(0);
      expect(view.accountTotals).toEqual([]);
    });

    it("从没同步过的账户 → 出现在 accountTotals 里,takenAt 是空", async () => {
      await seedAccount(USER, "没同步过", "bitcoin");

      const view = await call(USER, handleGetPortfolioOverview({}));

      expect(view.accountTotals).toHaveLength(1);
      expect(view.accountTotals[0].takenAt).toBeNull();
    });

    it("入参缺省 → schema 给出默认值,loader 不带参也能调", () => {
      expect(PortfolioScopeInput.parse(undefined)).toEqual({});
    });

    it("pin 的 kind 不在枚举里 → schema 拒", () => {
      expect(PortfolioScopeInput.safeParse({ pin: { kind: "portfolio" } }).success).toBe(false);
    });
  });
});
