import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRemoveAccount } from "@/lib/server/accounts/remove";
import { importData } from "@/lib/server/io/import-data";
import { handleCreateManualActivities } from "@/lib/server/manual-activities/create";
import { handleGetAccountGain24h, handleGetPortfolioGain24h } from "@/lib/server/portfolio/gain";
import {
  accountGainKey,
  computeAccountGain24h,
  computePortfolioGain24h,
  invalidatePrecomputed,
  overviewKey,
  PRECOMPUTE_TTL_MS,
  portfolioGainKey,
  tabStripKey,
} from "@/lib/server/portfolio/precompute";
import { handleSetDefaultPortfolio } from "@/lib/server/portfolios/set-default";
import { handleSyncAccount } from "@/lib/server/sync/run";
import { handleAttachTag } from "@/lib/server/tags/attach";
import { handleDetachTag } from "@/lib/server/tags/detach";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, precompute as precomputeFor, readOverview, until } from "../_kit/run";
import { DAY, seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

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
  const precompute = (portfolioId?: string) => precomputeFor(USER, portfolioId);

  const readPortfolio = (data: Parameters<typeof handleGetPortfolioGain24h>[1] = {}) =>
    call(USER, handleGetPortfolioGain24h(USER, data));
  const readAccounts = (data: Parameters<typeof handleGetAccountGain24h>[1] = {}) =>
    call(USER, handleGetAccountGain24h(USER, data));

  // 一个有基准、算得出数的组合,下面好几组共用。
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

      const view = await readOverview(USER, {});

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
    it("落的键 = 组合 ×(默认 + 每个 pin),外加一份账户级", async () => {
      const acc = await seedTwoDays();
      const tag = await db(USER).tags.create({ name: "长期", portfolioId: (await defaultPf()).id });
      await db(USER).tags.attach(acc.id, tag.id);
      await db(USER).tabPins.create({ kind: "tag", tagId: tag.id });
      await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });

      const pf = await precompute();

      // 一个维度一个键:默认视图 + 每个说得通的 pin,外加两族不吃 pin 的(账户级盈亏、tab 条)。
      const at = async (k: string) => (await db(USER).cache.get(k))._tag;
      const tagPin = { kind: "tag", tagId: tag.id } as const;
      expect(await at(portfolioGainKey(pf, null))).toBe("Some");
      expect(await at(portfolioGainKey(pf, tagPin))).toBe("Some");
      expect(await at(portfolioGainKey(pf, { kind: "connector", connectorId: "bitcoin" }))).toBe(
        "Some",
      );
      expect(await at(accountGainKey(pf, null))).toBe("Some");
      // 总览与 tab 条与它们一批落下(FOL-36)—— 四族一趟算完、一次 putMany。
      expect(await at(overviewKey(pf, null))).toBe("Some");
      expect(await at(overviewKey(pf, tagPin))).toBe("Some");
      expect(await at(tabStripKey(pf, null))).toBe("Some");
      // 这个组合里说不通的 pin 不占一个键(判据与首页 tab 条同一个 `pinsInView`)。
      expect(await at(portfolioGainKey(pf, { kind: "connector", connectorId: "binance" }))).toBe(
        "None",
      );
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
      // 落库形状是 `{ computedAt, value }` —— `computedAt` 拿「现在」,于是它晚于水位线、算数。
      await db(USER).cache.put(
        portfolioGainKey(pf, null),
        { computedAt: Date.now(), value: planted },
        PRECOMPUTE_TTL_MS,
      );

      const out = await readPortfolio({ portfolioId: pf });

      expect(out).toEqual(planted);
    });

    // 验收 ③ 的后半 —— 没算过就回空态,补算走后台;读请求本体不等它。
    it("没算过 → 空态形状 + 后台补算(补完的数与现算一致)", async () => {
      const acc = await seedTwoDays();
      const pf = (await defaultPf()).id;

      const out = await readPortfolio({ portfolioId: pf });

      // 读的那一刻:空态 + 一句「还在算」,而且键上确实什么都还没有 —— 这次请求里没有算过。
      expect(out).toEqual({ portfolio: null, holdings: {}, defi: {}, pending: true });
      // 后台那一趟(`waitUntil`)跑完之后键才出现。轮询而不是等固定毫秒:断言的是
      // 「它会补上」,不是「它多快补上」。
      const filled = await until(
        () => db(USER).cache.get(portfolioGainKey(pf, null)),
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
        () => db(USER).cache.get(portfolioGainKey(pf, null)),
        (o) => o._tag === "Some",
      );
      expect((await db(USER).cache.get(portfolioGainKey(bogus, null)))._tag).toBe("None");
    });

    // 算好了就是终局,一个字都不多说 —— 否则前端会白轮询下去。
    it("算好了 → 不带 pending", async () => {
      await seedTwoDays();
      await precompute();

      expect((await readPortfolio()).pending).toBeUndefined();
      expect((await readAccounts()).pending).toBeUndefined();
    });

    // 这个 pin 在这个组合里根本说不通(预计算不会给它落键)→ 空就是它的**终局答案**。
    // 说成 pending 的话前端会一直轮询一个永远填不上的键,每一轮还安排一趟全量重算 ——
    // 一句客户端参数换来无界的后台工作。
    it("组合里说不通的 pin → 空态是终局,不 pending、不安排补算", async () => {
      await seedTwoDays(); // 只有 bitcoin 账户,没有 binance 的
      await precompute();
      const pf = (await defaultPf()).id;

      const out = await readPortfolio({
        portfolioId: pf,
        pin: { kind: "connector", connectorId: "binance" },
      });

      expect(out).toEqual({ portfolio: null, holdings: {}, defi: {} });
      expect(out.pending).toBeUndefined();
      // 而且没人去给它建键 —— 等一会儿再看,仍然是空的。
      await new Promise((r) => setTimeout(r, 100));
      expect(
        (
          await db(USER).cache.get(
            portfolioGainKey(pf, { kind: "connector", connectorId: "binance" }),
          )
        )._tag,
      ).toBe("None");
    });
  });

  // —— 输入变了就得标旧,否则「fresh 但是错的」会挂 90 分钟 ——
  describe("写操作让预计算失效", () => {
    const twoAccounts = async () => {
      const keep = await seedAccount(USER, "留着的", "bitcoin");
      await seedSnapshot(USER, keep.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, keep.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 110 }]);
      const doomed = await seedAccount(USER, "要删的", "binance");
      await seedSnapshot(USER, doomed.id, ago(DAY), [{ tokenId: ETH, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, doomed.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 300 }]);
      return { keep, doomed };
    };

    // 这条钉的是那个「不报错的错」:账户删了,而 24h 数字里还留着它的贡献,屏幕上没有
    // 任何东西能解释那笔钱。没有标旧的话它以 `stale === false` 的身份被端上去,最长 90 分钟。
    it("删掉一个账户 → 存下来的数当场作废,读到的是旧值 + pending,补算后它不见了", async () => {
      const { doomed } = await twoAccounts();
      await precompute();
      expect(Object.keys((await readPortfolio()).holdings).sort()).toEqual([BTC, ETH]);

      await call(USER, handleRemoveAccount({ accountId: doomed.id }));

      // 紧接着那一次读:**旧值照样端出去**(界面不空一下),但如实说一句「还在算」——
      // 前端据此短轮询,而这一读同时安排了补算。
      const rightAfter = await readPortfolio();
      expect(rightAfter.pending).toBe(true);

      // 补算落地之后,被删账户的那一行就不在了,而且不再 pending。
      const settled = await until(
        () => readPortfolio(),
        (o) => o.pending == null,
      );
      expect(Object.keys(settled.holdings)).toEqual([BTC]);
    });

    // F3:补算跨在写操作两边 —— 它开工时读到的是旧数据,落库时数据已经改了。
    // **落的时间戳是开工那一刻**,所以它恒小于写操作抬起来的水位线 → 读那头判它不算数。
    // 没有这一条,那份「改动前的数」会带着崭新的 90 分钟 TTL 被当成对的端出去。
    it("补算跨在写操作两边 → 它算出来的那份不算数", async () => {
      const { doomed } = await twoAccounts();
      const pf = (await defaultPf()).id;
      // 手工重演那个交错:先记下「开工时刻」,再改数据,最后拿开工时刻把结果写进去 ——
      // 这正是一趟真补算的三步,只是把中间那步换成了用户的写。
      const computedAt = Date.now();
      const stale = await call(USER, computePortfolioGain24h({ portfolioId: pf }));
      await call(USER, handleRemoveAccount({ accountId: doomed.id }));
      await db(USER).cache.put(
        portfolioGainKey(pf, null),
        { computedAt, value: stale },
        PRECOMPUTE_TTL_MS,
      );

      // TTL 还新鲜,但它是拿删之前的原料算的 —— 必须判成不算数。
      const out = await readPortfolio({ portfolioId: pf });
      expect(out.pending).toBe(true);

      const settled = await until(
        () => readPortfolio({ portfolioId: pf }),
        (o) => o.pending == null,
      );
      expect(Object.keys(settled.holdings)).toEqual([BTC]);
    });

    // F2:cron 一次 sweep 里各组合的轮是并发跑的,收官各抬各的水位线。抬用户级那条的话,
    // 先算完的组合会被后收官的组合当场作废 —— 一趟下来除了最后一个,其余全得重算。
    it("一个组合失效,不牵连另一个组合", async () => {
      const here = await seedAccount(USER, "默认里的", "bitcoin");
      await seedSnapshot(USER, here.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, here.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 110 }]);
      const watch = await db(USER).portfolios.create({ name: "看单" });
      const there = await seedAccount(USER, "看单里的", "binance");
      await db(USER).portfolios.assignAccount(there.id, watch.id);
      await seedSnapshot(USER, there.id, ago(DAY), [{ tokenId: ETH, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, there.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 130 }]);
      const home = (await defaultPf()).id;
      await precompute(home);
      await precompute(watch.id);

      // 「看单」那一轮收官 —— 只抬它自己那条水位线。
      await call(USER, invalidatePrecomputed(watch.id));

      expect((await readPortfolio({ portfolioId: watch.id })).pending).toBe(true);
      expect((await readPortfolio({ portfolioId: home })).pending).toBeUndefined();
    });

    it("改标签(挂 / 摘)→ 当场作废(tag pin 那一维正是按它的账户集算的)", async () => {
      const acc = await seedTwoDays();
      const tag = await db(USER).tags.create({ name: "长期", portfolioId: (await defaultPf()).id });
      await precompute();
      expect((await readPortfolio()).pending).toBeUndefined();

      await call(USER, handleAttachTag({ accountId: acc.id, tagId: tag.id }));
      expect((await readPortfolio()).pending).toBe(true);

      await precompute();
      await call(USER, handleDetachTag({ accountId: acc.id, tagId: tag.id }));
      expect((await readPortfolio()).pending).toBe(true);
    });

    it("改默认组合 → 当场作废(inView 的兜底与 resolveScope 的落点一起挪)", async () => {
      await seedTwoDays();
      const watch = await db(USER).portfolios.create({ name: "看单" });
      await precompute();
      expect((await readPortfolio()).pending).toBeUndefined();

      await call(USER, handleSetDefaultPortfolio({ portfolioId: watch.id }));

      expect((await readPortfolio()).pending).toBe(true);
    });

    it("单账户同步 → 当场作废", async () => {
      const acc = await seedAccount(USER, "币安", "binance");
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 110 }]);
      await precompute();
      expect((await readPortfolio()).pending).toBeUndefined();

      // 出网被掐,这个账户没有凭据 → 内核走 skipped 那一支,不写快照、也就不该抬水位线。
      await call(USER, handleSyncAccount(USER, { accountId: acc.id }));
      expect((await readPortfolio()).pending).toBeUndefined();
    });

    // F6:导入直接走 `transfer.*`,绕过每一个写 handler —— 所以它得自己抬。
    // 这是 e2e 那个 bug 换一扇门:灌进来一堆新数据,而 24h 盈亏仍以「新鲜」的身份端着导入前
    // 那份(常常是一片空)。
    it("导入 → 当场作废(它绕过全部写 handler)", async () => {
      await seedTwoDays();
      await precompute();
      expect((await readPortfolio()).pending).toBeUndefined();

      // 一行合法记录就够 —— 这条钉的是「导入这条路会不会抬水位线」,不是导入本身对不对
      // (那有 export-import-roundtrip 管)。
      const ndjson = `${JSON.stringify({ type: "meta", version: 2 })}\n`;
      const stream = new Response(ndjson).body;
      if (!stream) throw new Error("no body");
      await call(USER, importData(stream.getReader()));

      expect((await readPortfolio()).pending).toBe(true);
    });

    it("改手记账本(加一笔)→ 同样当场作废", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50_000,
        amount: 2,
      });
      await precompute();
      expect((await readAccounts()).pending).toBeUndefined();

      await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [
            {
              token: { symbol: "BTC", unitPrice: 50_000 },
              kind: "add",
              amount: 1,
              occurredAt: NOW,
            },
          ],
        }),
      );

      expect((await readAccounts()).pending).toBe(true);
    });
  });

  // —— 手记账户从不进同步轮(ADR 0018:它不写快照,`isSyncableAccount` 也把它挡在名单外)——
  //
  // 于是「同步收官」这个唯一的预计算时机对纯手记用户**永远不发生**。这条钉的是那个缺口:
  // 建完账户第一次读必须自己把话说清楚(空态 + pending)并把补算安排上,而补完之后那个数
  // 是 **0**(活动就发生在此刻)—— 不是「算不出」。0 与「没有这个数」在界面上长得不一样,
  // 而 e2e(`e2e/manual-gain.spec.ts`)数的正是那三个 `$0.00`。
  describe("纯手记用户(从不跑同步轮)", () => {
    it("建完手记账户 → 第一次读是空态 + pending,补算之后是 0 而不是「算不出」", async () => {
      const acc = await seedManualAccount(USER, "E2E Manual", {
        symbol: "BTC",
        unitPrice: 50_000,
        amount: 2,
      });

      const cold = await readAccounts();
      expect(cold).toEqual({ accounts: {}, balances: {}, pending: true });

      const warm = await until(
        () => readAccounts(),
        (o) => o.pending == null,
      );
      // **0,不是 null。** null 是「算不出」,界面画 `—`;0 是「没涨没跌」,界面画 $0.00。
      expect(warm.accounts[acc.id]?.amount).toBe(0);
      expect(warm.accounts[acc.id]?.pct).toBe(0);
      const balance = Object.values(warm.balances)[0];
      expect(balance?.amount).toBe(0);
      expect(balance?.pct).toBe(0);

      // 组合级那一份是同一趟补算落下的(补算按组合补全部维度),所以它也已经就位。
      const portfolio = await readPortfolio();
      expect(portfolio.pending).toBeUndefined();
      expect(portfolio.portfolio?.amount).toBe(0);
    });
  });
});
