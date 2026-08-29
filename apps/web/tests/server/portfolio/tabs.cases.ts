import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeHomeTabStrip,
  PRECOMPUTE_TTL_MS,
  tabStripKey,
} from "@/lib/server/portfolio/precompute";
import { handleGetHomeTabStrip } from "@/lib/server/portfolio/tabs";
import { handleCreateTabPin } from "@/lib/server/tab-pins/create";
import { handleRenameTag } from "@/lib/server/tags/rename";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, precompute, readTabStrip, until } from "../_kit/run";
import { seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolio/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolio/tabs", () => {
  // #527 · getHomeTabStrip
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

  const read = (data: { portfolioId?: string } = {}) =>
    call(USER, handleGetHomeTabStrip(USER, data));

  describe("getHomeTabStrip", () => {
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
      // 三个 pin 全指向默认组合里的东西:标签、账户、以及只有默认组合才有的 connector。
      await db(USER).tabPins.create({ kind: "tag", tagId: defTag.id });
      await db(USER).tabPins.create({ kind: "account", accountId: mine.id });
      await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });

      expect(
        (await readTabStrip(USER, { portfolioId: def.id })).pins.map((p) => p.kind).length,
      ).toBe(3);
      // Watch 里这三个一个都不该出现 —— 点进去只会是空视图。
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
          // **权益行必须带 meta。** `toPerpView` 只在 `PerpEquityMeta.safeParse` 成功时才置
          // `equity`,而 `hasPerps` 看的正是它 —— 少了 meta,这一栏在界面上就整个不出现。
          // 第一版我没给 meta,于是 hasPerps 是 false,看着像 bug,其实是夹具没喂够。
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

    // —— FOL-36:tab 条也改成读预计算(ADR 0049)——

    // **这条不是对拍,别把它当对拍看。**
    //
    // 总览那边有真参照:`buildScopedOverview({}, false)` 逐字就是改造前那个 handler 的全部内容,
    // 而它住在 `scope.ts`、这一片没动过。tab 条没有这种参照 —— 改造前的 handler 体被原样搬进了
    // `computeHomeTabStrip`,拿它当参照只能证明「读出来的等于写进去的」,证明不了「算得对」。
    //
    // 所以这条用例的重量在下半截:**条子的内容对不对,由夹具直接推出来**(种了一个永续账户 →
    // hasPerps;没种 DeFi → hasDefi 假;钉了一个标签 → 条上恰好一格,叫「长期」)。上半截那句
    // `toEqual` 留着,它管的是另一件事:读接口真的只是把存下来的那份原样端出来(JSON 存取
    // 一个来回没把它弄花),而不是在读的时候又算了一遍。
    it("读出来的就是写进去的那一份,而那一份与这个组合的实际情况对得上", async () => {
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
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

      const inline = await call(USER, computeHomeTabStrip({}));
      await precompute(USER);
      const served = await read();

      expect(served).toEqual(inline); // 存进去的原样端出来
      // 内容由夹具直接推出来,不看被测代码的脸色:
      expect(served.hasAccounts).toBe(true); // 种了一个账户,在默认组合里
      expect(served.hasPerps).toBe(true); // 那个账户有永续权益行(带 meta,否则 toPerpView 不认)
      expect(served.hasDefi).toBe(false); // 一条 DeFi 行都没种
      expect(served.pins).toHaveLength(1); // 只钉了一个
      expect(served.pins[0].kind).toBe("tag");
      expect(served.pins[0].name).toBe("长期"); // 名字是服务端解析好的标签名
      expect(served.pending).toBeUndefined();
    });

    // 验收 ③ 的前半 —— 直出键上那份,读请求里没有计算。
    it("直出键上那份,读请求里没有计算", async () => {
      await seedAccount(USER, "甲", "bitcoin");
      const pf = (await db(USER).portfolios.ensureDefault()).id;
      const planted = {
        hasAccounts: true,
        hasPerps: true,
        hasDefi: true,
        pins: [{ id: "凭空", kind: "tag" as const, tagId: "不存在的标签", name: "不可能" }],
      };
      await db(USER).cache.put(
        tabStripKey(pf, null),
        { computedAt: Date.now(), value: planted },
        PRECOMPUTE_TTL_MS,
      );

      expect(await read({ portfolioId: pf })).toEqual(planted);
    });

    it("没算过 → 空态形状 + 后台补算", async () => {
      await seedAccount(USER, "甲", "bitcoin");

      expect(await read()).toEqual({
        hasAccounts: false,
        hasPerps: false,
        hasDefi: false,
        pins: [],
        pending: true,
      });

      expect((await until(read, (o) => o.pending == null)).hasAccounts).toBe(true);
    });

    // 失效点:标签名就摆在 tab 条上,而条子是算好存下来的 —— 改名不抬水位线就一直是旧名字。
    it("标签改名 → 当场不算数,补算之后条上换成新名字", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const acc = await seedAccount(USER, "甲", "bitcoin");
      const tag = await db(USER).tags.create({ portfolioId: pf.id, name: "旧名字" });
      await db(USER).tags.attach(acc.id, tag.id);
      await db(USER).tabPins.create({ kind: "tag", tagId: tag.id });
      await precompute(USER);
      expect((await read()).pins[0].name).toBe("旧名字");

      await call(USER, handleRenameTag({ tagId: tag.id, name: "新名字" }));

      expect((await read()).pending).toBe(true);
      expect((await until(read, (o) => o.pending == null)).pins[0].name).toBe("新名字");
    });

    // 失效点的**范围**:钉一个属于某个组合的 Tab,只该作废那个组合。
    //
    // 抬整个用户那条水位线是能用的,但它把这个用户每个组合的四族预计算全部作废 —— 而钉一个
    // Tab 一分钱余额都没改。这条钉的就是那个范围;它一旦退回用户级,「别的组合还算数」会红。
    it("钉一个属于某组合的 Tab → 只作废那个组合,别的组合的数还算数", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const watch = await db(USER).portfolios.create({ name: "看单" });
      const mine = await seedAccount(USER, "自己的", "bitcoin");
      await db(USER).portfolios.assignAccount(mine.id, def.id);
      const there = await seedAccount(USER, "看单里的", "binance");
      await db(USER).portfolios.assignAccount(there.id, watch.id);
      await precompute(USER, def.id);
      await precompute(USER, watch.id);

      // account pin 只出现在这个账户所在的那个组合的条子上。
      await call(USER, handleCreateTabPin({ kind: "account", accountId: mine.id }));

      expect((await read({ portfolioId: def.id })).pending).toBe(true);
      expect((await read({ portfolioId: watch.id })).pending).toBeUndefined();
    });

    // 失效点:钉一个 Tab 改的就是这份数据本身(以及多出来的那一维)。
    it("钉一个 Tab → 当场不算数,补算之后条上多一格", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await db(USER).portfolios.assignAccount(acc.id, pf.id);
      await precompute(USER);
      expect((await read()).pins).toEqual([]);

      await db(USER).tabPins.create({ kind: "account", accountId: acc.id });
      await call(USER, handleCreateTabPin({ kind: "connector", connectorId: "bitcoin" }));

      expect((await read()).pending).toBe(true);
      expect((await until(read, (o) => o.pending == null)).pins).toHaveLength(2);
    });
  });
});
