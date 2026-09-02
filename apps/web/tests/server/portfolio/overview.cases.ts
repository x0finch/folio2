import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { PortfolioScopeInput } from "@/lib/server/portfolio/scope";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, readOverview, readSnapshotData } from "../_kit/run";
import { seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolio/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
//
// **FOL-48 / FOL-54:总览改成「原子读 + 浏览器算」。** `readOverview` 走原子原料 +
// `overviewFromSnapshotData`(= 前端 `select` 那一行),不复刻业务逻辑。
describe("portfolio/overview", () => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("总览(快照原料 + 客户端算)", () => {
    it("三个账户各有仓 → 同一个币合并成一行,金额是各账户之和", async () => {
      for (const [label, value] of [
        ["甲", 100],
        ["乙", 200],
        ["丙", 300],
      ] as const) {
        const acc = await seedAccount(USER, label, "bitcoin");
        await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: value }]);
      }

      const view = await readOverview(USER, {});

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

      const view = await readOverview(USER, {});

      expect(view.holdings).toHaveLength(2);
      expect(view.totalUsd).toBe(150);
    });

    it("手记账户与链上账户持有同一个币 → 合并成一行,来源两条", async () => {
      // **合并的键是 tokenId,不是 symbol。** 所以这个场景必须让两边指向同一行代币 ——
      // 先建手记账户(它经 mint 建出真代币行),读出那个 id,再拿它去种链上那张快照。
      const manual = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50,
        amount: 2,
      });
      const detail = await call(USER, handleGetManualAccount({ accountId: manual.id }));
      const mintedBtc = detail.tokens[0].id;

      const chain = await seedAccount(USER, "链上", "bitcoin");
      await seedSnapshot(USER, chain.id, NOW, [{ tokenId: mintedBtc, amount: 1, usdValue: 100 }]);

      const view = await readOverview(USER, {});

      const btcRow = view.holdings.find((h) => (h.totalAmount ?? 0) >= 3);
      expect(btcRow).toBeDefined();
      expect(btcRow?.sources.length).toBeGreaterThanOrEqual(2);
    });

    it("perp 亏穿、净值为负 → 总额如实为负,不被夹成 0", async () => {
      const acc = await seedAccount(USER, "永续", "hyperliquid");
      await seedSnapshot(USER, acc.id, NOW, [
        { tokenId: "token-perp", amount: 1, usdValue: -500, kind: "perp_equity" },
      ]);

      const view = await readOverview(USER, {});

      expect(view.totalUsd).toBe(-500);
    });

    it("带 pin 按 connector 收窄 → 只算那个上游的账户", async () => {
      const btcAcc = await seedAccount(USER, "链上", "bitcoin");
      await seedSnapshot(USER, btcAcc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      const cexAcc = await seedAccount(USER, "交易所", "binance");
      await seedSnapshot(USER, cexAcc.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 900 }]);

      const view = await readOverview(USER, {
        pin: { kind: "connector", connectorId: "bitcoin" },
      });

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

      const view = await readOverview(USER, { portfolioId: theirPf.id });

      expect(view.totalUsd).toBe(100);
    });

    it("全新用户 → 空但结构完整的视图,不是报错", async () => {
      const view = await readOverview(USER, {});

      expect(view.holdings).toEqual([]);
      expect(view.sections).toEqual([]);
      expect(view.totalUsd).toBe(0);
      expect(view.accountTotals).toEqual([]);
    });

    it("从没同步过的账户 → 出现在 accountTotals 里,takenAt 是空", async () => {
      await seedAccount(USER, "没同步过", "bitcoin");

      const view = await readOverview(USER, {});

      expect(view.accountTotals).toHaveLength(1);
      expect(view.accountTotals[0].takenAt).toBeNull();
    });
  });

  describe("快照原料(原子装配)", () => {
    it("只发原料:取行 + 备料,不聚合", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const raw = await readSnapshotData(USER, {});

      // 账户 + 原始快照「行」都在,而不是合计。
      expect(raw.accounts.map((a) => a.label)).toEqual(["甲"]);
      expect(raw.snapshots).toHaveLength(1);
      const [[accId, snap]] = raw.snapshots;
      expect(accId).toBe(acc.id);
      expect(snap.balances.map((b) => b.tokenId)).toEqual([BTC]);
      expect(snap.balances[0].usdValue).toBe(100);
      // 备的是字典 + 口径,没有任何聚合字段(总额 / 持仓 / 小计 都不在原料里)。
      expect(raw.mode).toBe("self-first");
      expect(raw).not.toHaveProperty("totalUsd");
      expect(raw).not.toHaveProperty("holdings");
      expect(raw).not.toHaveProperty("holdingsSubtotal");
      expect(raw).not.toHaveProperty("pricesStale");
    });

    it("按 scope 在原料里就筛好:pin 只发那个上游的账户", async () => {
      const btcAcc = await seedAccount(USER, "链上", "bitcoin");
      await seedSnapshot(USER, btcAcc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      const cexAcc = await seedAccount(USER, "交易所", "binance");
      await seedSnapshot(USER, cexAcc.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 900 }]);

      const raw = await readSnapshotData(USER, {
        pin: { kind: "connector", connectorId: "bitcoin" },
      });

      expect(raw.accounts.map((a) => a.label)).toEqual(["链上"]);
      expect(raw.snapshots.map(([id]) => id)).toEqual([btcAcc.id]);
    });
  });

  describe("入参 schema", () => {
    it("入参缺省 → schema 给出默认值,loader 不带参也能调", () => {
      expect(PortfolioScopeInput.parse(undefined)).toEqual({});
    });

    it("pin 的 kind 不在枚举里 → schema 拒", () => {
      expect(PortfolioScopeInput.safeParse({ pin: { kind: "portfolio" } }).success).toBe(false);
    });
  });
});
