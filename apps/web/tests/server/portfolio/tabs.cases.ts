import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCreateTabPin } from "@/lib/server/tab-pins/create";
import { handleRenameTag } from "@/lib/server/tags/rename";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, readTabStrip } from "../_kit/run";
import { seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolio/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolio/tabs", () => {
  // FOL-49 · getPortfolioRoster + computeHomeTabStrip
  const USER = "h-pf-tabs";

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

  describe("home tab strip", () => {
    it("两个 pin → tab 条里出现这两个,标签是解析好的人话", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const acc = await seedAccount(USER, "我的钱包", "bitcoin");
      await db(USER).portfolios.assignAccount(acc.id, pf.id);
      const tag = await db(USER).tags.create({ portfolioId: pf.id, name: "长期" });
      await db(USER).tabPins.create({ kind: "tag", tagId: tag.id });
      await db(USER).tabPins.create({ kind: "account", accountId: acc.id });

      const strip = await readTabStrip(USER, {});

      expect(strip.pins.map((p) => p.name).sort()).toEqual(["我的钱包", "长期"]);
    });

    it("别的组合的 pin 不摆在这个组合的 tab 条里(三类各一个)", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const watch = await db(USER).portfolios.create({ name: "Watch" });
      const mine = await seedAccount(USER, "自己的", "bitcoin");
      const watched = await seedAccount(USER, "只看看", "binance");
      await db(USER).portfolios.assignAccount(mine.id, def.id);
      await db(USER).portfolios.assignAccount(watched.id, watch.id);
      const defTag = await db(USER).tags.create({ portfolioId: def.id, name: "长期" });
      await db(USER).tabPins.create({ kind: "tag", tagId: defTag.id });
      await db(USER).tabPins.create({ kind: "account", accountId: mine.id });
      await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });

      expect(
        (await readTabStrip(USER, { portfolioId: def.id })).pins.map((p) => p.kind).length,
      ).toBe(3);
      expect((await readTabStrip(USER, { portfolioId: watch.id })).pins).toEqual([]);
    });

    it("connector pin 在**有这个 connector 的每个组合**里都摆(它是个镜头,不归属组合)", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const watch = await db(USER).portfolios.create({ name: "Watch" });
      const a = await seedAccount(USER, "甲", "binance");
      const b = await seedAccount(USER, "乙", "binance");
      await db(USER).portfolios.assignAccount(a.id, def.id);
      await db(USER).portfolios.assignAccount(b.id, watch.id);
      await db(USER).tabPins.create({ kind: "connector", connectorId: "binance" });

      for (const pf of [def.id, watch.id]) {
        expect((await readTabStrip(USER, { portfolioId: pf })).pins).toHaveLength(1);
      }
    });

    it("没有任何 pin → pins 是空的", async () => {
      await seedAccount(USER, "甲", "bitcoin");

      expect((await readTabStrip(USER, {})).pins).toEqual([]);
    });

    it("有 perp 仓 → hasPerps 为真;有 DeFi 仓 → hasDefi 为真", async () => {
      const acc = await seedAccount(USER, "永续", "hyperliquid");
      await seedSnapshot(USER, acc.id, NOW, [
        {
          tokenId: "token-perp",
          amount: 1,
          usdValue: 100,
          kind: "perp_equity",
          meta: { withdrawable: 60, totalMarginUsed: 40, totalNtlPos: 400 },
        },
        {
          tokenId: "token-defi",
          amount: 1,
          usdValue: 200,
          kind: "defi",
          meta: { protocol: "aave", protocolName: "Aave" },
        },
      ]);

      const strip = await readTabStrip(USER, {});

      expect(strip.hasPerps).toBe(true);
      expect(strip.hasDefi).toBe(true);
    });

    it("全新用户(零账户零 pin)→ hasAccounts 为假,不报错", async () => {
      const strip = await readTabStrip(USER, {});

      expect(strip.hasAccounts).toBe(false);
      expect(strip.hasPerps).toBe(false);
      expect(strip.hasDefi).toBe(false);
      expect(strip.pins).toEqual([]);
    });

    it("切到别的 Portfolio → 不把上一个的持仓带过来", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const other = await db(USER).portfolios.create({ name: "另一个" });
      const acc = await seedAccount(USER, "甲", "hyperliquid");
      await db(USER).portfolios.assignAccount(acc.id, def.id);
      await seedSnapshot(USER, acc.id, NOW, [
        {
          tokenId: "token-perp",
          amount: 1,
          usdValue: 100,
          kind: "perp_equity",
          meta: { withdrawable: 60, totalMarginUsed: 40, totalNtlPos: 400 },
        },
      ]);

      const strip = await readTabStrip(USER, { portfolioId: other.id });

      expect(strip.hasAccounts).toBe(false);
      expect(strip.hasPerps).toBe(false);
    });

    it("别人的 pin 不出现在我的 tab 条里", async () => {
      await db(otherUser(USER)).tabPins.create({ kind: "connector", connectorId: "bitcoin" });

      expect((await readTabStrip(USER, {})).pins).toEqual([]);
    });

    it("有账户有永续有 pin → 条子与夹具对得上", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const acc = await seedAccount(USER, "我的钱包", "hyperliquid");
      await db(USER).portfolios.assignAccount(acc.id, pf.id);
      await seedSnapshot(USER, acc.id, NOW, [
        {
          tokenId: "token-perp",
          amount: 1,
          usdValue: 100,
          kind: "perp_equity",
          meta: { withdrawable: 60, totalMarginUsed: 40, totalNtlPos: 400 },
        },
      ]);
      const tag = await db(USER).tags.create({ portfolioId: pf.id, name: "长期" });
      await db(USER).tabPins.create({ kind: "tag", tagId: tag.id });

      const served = await readTabStrip(USER, {});

      expect(served.hasAccounts).toBe(true);
      expect(served.hasPerps).toBe(true);
      expect(served.hasDefi).toBe(false);
      expect(served.pins).toHaveLength(1);
      expect(served.pins[0].kind).toBe("tag");
      expect(served.pins[0].name).toBe("长期");
    });

    it("标签改名 → 条上换成新名字", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const acc = await seedAccount(USER, "甲", "bitcoin");
      const tag = await db(USER).tags.create({ portfolioId: pf.id, name: "旧名字" });
      await db(USER).tags.attach(acc.id, tag.id);
      await db(USER).tabPins.create({ kind: "tag", tagId: tag.id });
      expect((await readTabStrip(USER, {})).pins[0].name).toBe("旧名字");

      await call(USER, handleRenameTag({ tagId: tag.id, name: "新名字" }));

      expect((await readTabStrip(USER, {})).pins[0].name).toBe("新名字");
    });

    it("钉一个 Tab → 条上多一格", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await db(USER).portfolios.assignAccount(acc.id, pf.id);
      expect((await readTabStrip(USER, {})).pins).toEqual([]);

      await db(USER).tabPins.create({ kind: "account", accountId: acc.id });
      await call(USER, handleCreateTabPin({ kind: "connector", connectorId: "bitcoin" }));

      expect((await readTabStrip(USER, {})).pins).toHaveLength(2);
    });
  });
});
