import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeAccountGain24h,
  computePortfolioGain24h,
  GAIN_PRECOMPUTE_TTL_MS,
  handleGetAccountGain24h,
  handleGetPortfolioGain24h,
  precomputeGain24h,
} from "@/lib/server/portfolio/gain";
import { handleGetPortfolioOverview } from "@/lib/server/portfolio/overview";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { DAY, seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

/**
 * 轮询到条件成立(或用完次数)。**不断言墙上时钟** —— 后台补算跑在 `waitUntil` 上,测试
 * 拿不到那条 Promise,而「等固定毫秒再断言」正是 CODING.md 点名的 flaky 写法。
 */
const until = async <A>(read: () => Promise<A>, ok: (a: A) => boolean, tries = 100): Promise<A> => {
  let last = await read();
  for (let i = 0; i < tries && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, 20));
    last = await read();
  }
  return last;
};

// 合并进 portfolio/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolio/gain", () => {
  // #527 · getPortfolioGain24h / getAccountGain24h
  //
  // 窗口是 24 小时,基准点允许偏离窗口起点 ±2 小时(快照是稀疏的,不会正好落在那一刻)。
  // 所以「有基准」的场景要把旧快照放在 24h 前附近,「没基准」的场景放在远得多的地方。
  //
  // **FOL-35 之后这两条读接口只做「读 + 传」**(ADR 0049):数字是同步收官时算好的,
  // 所以每个要断言数字的用例都得先让预计算跑一遍(`precompute()`)。少了那一步读到的是空态 ——
  // 而那正是下面「缺预计算」那一组要测的东西。
  const USER = "h-pf-gain";
  const BTC = "token-btc";
  const ETH = "token-eth";

  let NOW = 0;
  const ago = (ms: number) => NOW - ms;

  const defaultPf = () => db(USER).portfolios.ensureDefault();

  /** 跑一遍预计算(= 同步收官时那一步),之后读接口才有东西可直出。 */
  const precompute = async (portfolioId?: string) => {
    const pf = portfolioId ?? (await defaultPf()).id;
    await call(USER, precomputeGain24h(pf));
    return pf;
  };

  const readPortfolio = (data: Parameters<typeof handleGetPortfolioGain24h>[1] = {}) =>
    call(USER, handleGetPortfolioGain24h(USER, data));
  const readAccounts = (data: Parameters<typeof handleGetAccountGain24h>[1] = {}) =>
    call(USER, handleGetAccountGain24h(USER, data));

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    NOW = Date.now();
  });

  afterEach(() => {
    vi.useRealTimers();
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
      await precompute();

      const out = await readPortfolio();

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
      await precompute();

      const out = await readPortfolio();

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
      await precompute();

      const out = await readPortfolio();

      expect(Object.keys(out.holdings)).toHaveLength(1);
    });

    it("同一个币在两个账户各有仓 → 字典 key 不撞,合并成一条", async () => {
      const a = await seedAccount(USER, "甲", "bitcoin");
      const b = await seedAccount(USER, "乙", "binance");
      for (const acc of [a, b]) {
        await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
        await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 120 }]);
      }
      await precompute();

      const out = await readPortfolio();

      expect(Object.keys(out.holdings)).toHaveLength(1);
      expect(Object.keys(out.holdings)[0]).toBe(BTC);
    });

    it("全新用户 → 三个字段都空,不报错", async () => {
      const out = await readPortfolio();

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
      await precompute();

      const out = await readPortfolio({ portfolioId: theirPf.id });

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
      await precompute();

      const out = await readAccounts();

      const rows = Object.values(out.balances).filter((g) => g != null);
      const sum = rows.reduce((s, g) => s + (g?.amount ?? 0), 0);
      expect(out.accounts[acc.id]?.amount).toBeCloseTo(sum, 6);
    });

    it("归档账户 → 账户级和余额级都不出现", async () => {
      const archived = await seedAccount(USER, "归档", "bitcoin");
      await seedSnapshot(USER, archived.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, archived.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 900 }]);
      await db(USER).accounts.setArchived(archived.id, true);
      await precompute();

      const out = await readAccounts();

      expect(out.accounts[archived.id]).toBeUndefined();
      expect(Object.keys(out.balances)).toEqual([]);
    });

    it("算不出的账户 → 给 null,不给 0", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(10 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await precompute();

      const out = await readAccounts();

      expect(out.accounts[acc.id]).toBeNull();
    });

    it("全新用户 → 两个字典都是空的", async () => {
      const out = await readAccounts();

      expect(out.accounts).toEqual({});
      expect(out.balances).toEqual({});
    });
  });

  // —— FOL-35:预计算基建(ADR 0049)——
  describe("预计算", () => {
    // 一个有基准、算得出数的组合,后面几条共用。
    const seedTwoDays = async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(DAY), [
        { tokenId: BTC, amount: 1, usdValue: 100 },
        { tokenId: ETH, amount: 2, usdValue: 50 },
      ]);
      await seedSnapshot(USER, acc.id, NOW, [
        { tokenId: BTC, amount: 1, usdValue: 130 },
        { tokenId: ETH, amount: 2, usdValue: 60 },
      ]);
      return acc;
    };

    it("落的键 = 组合 ×(默认 + 每个 pin),外加一份账户级", async () => {
      const acc = await seedTwoDays();
      const tag = await db(USER).tags.create({ name: "长期", portfolioId: (await defaultPf()).id });
      await db(USER).tags.attach(acc.id, tag.id);
      await db(USER).tabPins.create({ kind: "tag", tagId: tag.id });
      await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });

      const pf = await precompute();

      // 键的形状与同步轮同一套约定(ADR 0048):`<族>:<组合>`,pin 维度再缀目标。
      // 这里写死字面量是刻意的 —— 它钉的就是这份约定,改了键该有人被红一次。
      const at = async (k: string) => (await db(USER).cache.get(k))._tag;
      expect(await at(`gain24h:${pf}`)).toBe("Some");
      expect(await at(`gain24h:${pf}:tag:${tag.id}`)).toBe("Some");
      expect(await at(`gain24h:${pf}:connector:bitcoin`)).toBe("Some");
      expect(await at(`gain24h-accounts:${pf}`)).toBe("Some");
      // 这个组合里说不通的 pin 不占一个键(判据与首页 tab 条同一个 `pinsInView`)。
      expect(await at(`gain24h:${pf}:connector:binance`)).toBe("None");
    });

    it("pin 那一份只装被它收窄的那些持仓", async () => {
      const btcOnly = await seedAccount(USER, "只有 BTC", "bitcoin");
      await seedSnapshot(USER, btcOnly.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, btcOnly.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 110 }]);
      const ethOnly = await seedAccount(USER, "只有 ETH", "binance");
      await seedSnapshot(USER, ethOnly.id, ago(DAY), [{ tokenId: ETH, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, ethOnly.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 190 }]);
      await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });
      await precompute();

      const pinned = await readPortfolio({ pin: { kind: "connector", connectorId: "bitcoin" } });
      const all = await readPortfolio();

      expect(Object.keys(pinned.holdings)).toEqual([BTC]);
      expect(Object.keys(all.holdings).sort()).toEqual([BTC, ETH]);
    });

    // 验收 ② —— 同一份输入,现算那条路与「预计算 + 读」那条路给的是同一组数字。
    // **时钟冻住再对拍**:两条路各自取一次 `Date.now()`,不冻的话分段的末点会差几毫秒,
    // 而那种差别会把「算法是不是同一个」这件事淹掉。
    it("读接口与现算逻辑对拍:同一份输入,两条路一个字都不差", async () => {
      const acc = await seedTwoDays();
      await seedSnapshot(USER, acc.id, ago(DAY / 2), [
        { tokenId: BTC, amount: 2, usdValue: 240 }, // 中途加仓 —— 让分段真的分出两段
        { tokenId: ETH, amount: 2, usdValue: 55 },
      ]);
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

      const inlinePortfolio = await call(USER, computePortfolioGain24h({}));
      const inlineAccounts = await call(USER, computeAccountGain24h({}));
      await precompute();
      const servedPortfolio = await readPortfolio();
      const servedAccounts = await readAccounts();

      expect(servedPortfolio).toEqual(inlinePortfolio);
      expect(servedAccounts).toEqual(inlineAccounts);
      // 夹具没有绕过被测代码:这一份真的有数,不是两个空对象碰在一起。
      expect(servedPortfolio.portfolio?.amount).toBeTruthy();
      expect(servedPortfolio.portfolio?.segments.length).toBeGreaterThan(1);
      expect(Object.keys(servedAccounts.accounts)).toEqual([acc.id]);
    });

    // 验收 ③ 的前半 —— 读接口直出,**不核对、不现算**。
    // 对抗性夹具:键上摆一个明显不是这份数据算得出来的值,读接口要原样交出来。
    // 它一旦偷偷现算,这条就会红成真实数字。
    it("直出键上那份,读请求里没有计算", async () => {
      await seedTwoDays();
      const pf = (await defaultPf()).id;
      const planted = {
        portfolio: { amount: -1234, pct: -5, segments: [] },
        holdings: {},
        defi: {},
      };
      await db(USER).cache.put(`gain24h:${pf}`, planted, GAIN_PRECOMPUTE_TTL_MS);

      const out = await readPortfolio({ portfolioId: pf });

      expect(out).toEqual(planted);
    });

    // 验收 ③ 的后半 —— 没算过就回空态,补算走后台;读请求本体不等它。
    it("没算过 → 空态形状 + 后台补算(补完的数与现算一致)", async () => {
      const acc = await seedTwoDays();
      const pf = (await defaultPf()).id;

      const out = await readPortfolio({ portfolioId: pf });

      // 读的那一刻:空态,而且键上确实什么都还没有 —— 这次请求里没有算过。
      expect(out).toEqual({ portfolio: null, holdings: {}, defi: {} });
      // 后台那一趟(`waitUntil`)跑完之后键才出现。轮询而不是等固定毫秒:断言的是
      // 「它会补上」,不是「它多快补上」。
      const filled = await until(
        () => db(USER).cache.get(`gain24h:${pf}`),
        (o) => o._tag === "Some",
      );
      expect(filled._tag).toBe("Some");
      // 补出来的不是个空壳:账户那一份也一起补上了(补算按组合补全部维度)。
      const again = await readPortfolio({ portfolioId: pf });
      expect(again.holdings[BTC]?.amount).toBeCloseTo(30, 6);
      const accounts = await readAccounts({ portfolioId: pf });
      expect(Object.keys(accounts.accounts)).toEqual([acc.id]);
    });

    it("补算不会把结果写到客户端瞎编的组合 id 上", async () => {
      await seedTwoDays();
      const bogus = "pf-never-existed";

      await readPortfolio({ portfolioId: bogus });

      // 解析退回默认组合,补算落在默认那个键上;瞎编的那个键一行都不许长出来。
      const pf = (await defaultPf()).id;
      await until(
        () => db(USER).cache.get(`gain24h:${pf}`),
        (o) => o._tag === "Some",
      );
      expect((await db(USER).cache.get(`gain24h:${bogus}`))._tag).toBe("None");
    });
  });
});
