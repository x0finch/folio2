import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleUpdateAccount } from "@/lib/server/accounts/update";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { handleGetPortfolioOverview } from "@/lib/server/portfolio/overview";
import { overviewKey, PRECOMPUTE_TTL_MS } from "@/lib/server/portfolio/precompute";
import { buildScopedOverview, PortfolioScopeInput } from "@/lib/server/portfolio/scope";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, precompute, readOverview, until } from "../_kit/run";
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

  afterEach(() => {
    vi.useRealTimers();
  });

  const read = (data: Parameters<typeof handleGetPortfolioOverview>[1] = {}) =>
    call(USER, handleGetPortfolioOverview(USER, data));

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
      // **这个 pin 得真的钉着**:预计算的维度 = 默认视图 + 每个说得通的 pin(FOL-36),
      // 没钉过的收窄不落键,读到的就是空态 —— 而界面上点得到的 Tab 恰恰只有钉着的那些。
      await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });

      const view = await readOverview(USER, { pin: { kind: "connector", connectorId: "bitcoin" } });

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

    // —— FOL-36:总览也改成读预计算(ADR 0049)——
    //
    // 下面这一组测的不再是「算得对不对」(上面那些已经在测了,只是路径换成了「预计算 + 读」),
    // 而是**那道缝**:两条路给的是不是同一份数、读的时候到底有没有在算、没算过会怎样。

    // 验收 ② —— 同一份输入,现算那条路与「预计算 + 读」那条路给的是同一组数字。
    // **时钟冻住再对拍**:两条路各自取一次 `Date.now()`,不冻的话价的新鲜度判定可能落在
    // 两侧,而那种差别会把「是不是同一份数」这件事淹掉。
    it("读接口与现算逻辑对拍:同一份输入,两条路一个字都不差", async () => {
      const chain = await seedAccount(USER, "链上", "bitcoin");
      await seedSnapshot(USER, chain.id, NOW, [
        { tokenId: BTC, amount: 1, usdValue: 100 },
        { tokenId: ETH, amount: 2, usdValue: 50 },
      ]);
      const perp = await seedAccount(USER, "永续", "hyperliquid");
      await seedSnapshot(USER, perp.id, NOW, [
        {
          tokenId: "token-perp",
          amount: 1,
          usdValue: 300,
          kind: "perp_equity",
          meta: { withdrawable: 200, totalMarginUsed: 100, totalNtlPos: 900 },
        },
        {
          tokenId: "token-defi",
          amount: 1,
          usdValue: 200,
          kind: "defi",
          meta: { protocol: "aave", protocolName: "Aave" },
        },
      ]);
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

      // 现算 = 这条接口在 FOL-36 之前的全部内容。
      const inline = await call(USER, buildScopedOverview({}));
      await precompute(USER);
      const served = await read();

      expect(served).toEqual(inline);
      // 夹具没有绕过被测代码:这一份真的有数,不是两个空对象碰在一起。
      expect(served.totalUsd).toBe(650); // 现货 150 + 永续权益 300 + DeFi 200
      expect(served.holdings.map((h) => h.key).sort()).toEqual([BTC, ETH]);
      expect(served.holdingsSubtotal).toBe(150);
      expect(served.defiSubtotal).toBe(200);
      expect(served.sections).toHaveLength(1); // 永续 + DeFi 同一个账户,一段
      expect(served.sections[0].perp?.equity).toBeTruthy();
      expect(served.pending).toBeUndefined();
    });

    // 验收 ③ 的前半 —— 读接口直出,**不核对、不现算**。
    // 对抗性夹具:键上摆一个明显不是这份数据算得出来的值,读接口要原样交出来。
    // 它一旦偷偷现算,这条就会红成真实数字。
    it("直出键上那份,读请求里没有计算", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      const pf = (await db(USER).portfolios.ensureDefault()).id;
      const planted = {
        holdings: [],
        sections: [],
        accountTotals: [
          { account: { id: "不存在的账户", label: "凭空" }, totalUsd: -1, takenAt: 7 },
        ],
        totalUsd: -424_242,
        holdingsSubtotal: 0,
        defiSubtotal: 0,
        pricesStale: false,
      };
      // 落库形状是 `{ computedAt, value }` —— `computedAt` 拿「现在」,于是它晚于水位线、算数。
      await db(USER).cache.put(
        overviewKey(pf, null),
        { computedAt: Date.now(), value: planted },
        PRECOMPUTE_TTL_MS,
      );

      expect(await read({ portfolioId: pf })).toEqual(planted);
    });

    // 验收 ③ 的后半 —— 没算过就回空态,补算走后台;读请求本体不等它。
    it("没算过 → 空态形状 + 后台补算(补完的数与现算一致)", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const cold = await read();

      // 空态 = 全新用户那一支的形状,一个字段都不少。
      expect(cold).toEqual({
        holdings: [],
        sections: [],
        accountTotals: [],
        totalUsd: 0,
        holdingsSubtotal: 0,
        defiSubtotal: 0,
        pricesStale: false,
        pending: true,
      });

      const settled = await until(read, (o) => o.pending == null);
      expect(settled.totalUsd).toBe(100);
    });

    it("输入变了 → 当场不算数(旧值照端 + `pending`),补算之后换成新的", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await precompute(USER);
      expect((await read()).totalUsd).toBe(100);

      // **改动之后那个数必须和改动之前不一样** —— 否则「补算跑了没有」这件事没有任何证据:
      // 一加一删的话前后都是 100,补算压根没跑这条用例照样绿。
      // 夹具直接塞一个新账户(不经写 handler,所以水位线没动),再用一次真的写把水位线抬起来。
      const other = await seedAccount(USER, "乙", "binance");
      await seedSnapshot(USER, other.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 900 }]);
      await call(USER, handleUpdateAccount({ accountId: acc.id, label: "甲(改过名)" }));

      const stale = await read();
      expect(stale.pending).toBe(true);
      expect(stale.totalUsd).toBe(100); // 旧值照端 —— 界面不会空一下
      expect((await until(read, (o) => o.pending == null)).totalUsd).toBe(1000);
    });

    it("入参缺省 → schema 给出默认值,loader 不带参也能调", () => {
      expect(PortfolioScopeInput.parse(undefined)).toEqual({});
    });

    it("pin 的 kind 不在枚举里 → schema 拒", () => {
      expect(PortfolioScopeInput.safeParse({ pin: { kind: "portfolio" } }).success).toBe(false);
    });
  });
});
