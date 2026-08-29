import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleListAccountHoldings } from "@/lib/server/portfolio/account-holdings";
import { handleGetAccountGain24h, handleGetPortfolioGain24h } from "@/lib/server/portfolio/gain";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, precompute as precomputeFor } from "../_kit/run";
import { DAY, HOUR, seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";
import { addManualActivities } from "../manual-fns";

// 合并进 portfolio/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolio/gain", () => {
  // FOL-43 / ADR 0050 · getPortfolioGain24h / getAccountGain24h
  //
  // **两端相减**:现在的值 − 24 小时前的值;起点 = ≤ 24h 前的最近一张快照(没有 → `null`)。
  // 这是用户裁定的口径 —— **充提计入当天盈亏是设计,不是 bug**,下面有专门的用例钉着它。
  //
  // 组合级的「现在」那一端读的是**存量总览**(与 hero 那个总额同源),所以要断言数字的用例
  // 都得先让预计算跑一遍(`precompute()`);账户级不读它,不用。
  const USER = "h-pf-gain";
  const BTC = "token-btc";
  const ETH = "token-eth";

  let NOW = 0;
  const ago = (ms: number) => NOW - ms;

  /** 跑一遍预计算(= 同步收官时那一步)—— 组合级盈亏的「现在」那一端从它读。 */
  const precompute = (portfolioId?: string) => precomputeFor(USER, portfolioId);

  const readPortfolio = (data: Parameters<typeof handleGetPortfolioGain24h>[0] = {}) =>
    call(USER, handleGetPortfolioGain24h(data));
  const readAccounts = (data: Parameters<typeof handleGetAccountGain24h>[0] = {}) =>
    call(USER, handleGetAccountGain24h(data));

  // 一个有起点、算得出数的组合,下面好几组共用。
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

  describe("getPortfolioGain24h —— 两端相减", () => {
    it("组合 = 现在总额 − 24h 前总额;各持仓行同口径,相加就是组合那个数", async () => {
      await seedTwoDays();
      await precompute();

      const out = await readPortfolio();

      // 150 → 190
      expect(out.portfolio?.amount).toBeCloseTo(40, 6);
      expect(out.portfolio?.pct).toBeCloseTo((40 / 150) * 100, 6);
      expect(out.holdings[BTC]?.amount).toBeCloseTo(30, 6);
      expect(out.holdings[BTC]?.pct).toBeCloseTo(30, 6);
      expect(out.holdings[ETH]?.amount).toBeCloseTo(10, 6);
      const sum = Object.values(out.holdings).reduce((s, g) => s + (g?.amount ?? 0), 0);
      expect(out.portfolio?.amount).toBeCloseTo(sum, 6);
    });

    it("起点 = ≤ 24h 的最近一张 —— 更晚的快照不许顶上来冒充", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      // 26 小时前(合法起点)、2 小时前(窗口内,**不是**起点)、现在。
      await seedSnapshot(USER, acc.id, ago(26 * HOUR), [
        { tokenId: BTC, amount: 1, usdValue: 100 },
      ]);
      await seedSnapshot(USER, acc.id, ago(2 * HOUR), [{ tokenId: BTC, amount: 1, usdValue: 120 }]);
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
      await precompute();

      const out = await readPortfolio();

      // 拿 2 小时前那张当起点的话是 10 —— 那是把「24h」偷偷截成 2 小时。
      expect(out.portfolio?.amount).toBeCloseTo(30, 6);
    });

    it("中途充值计入当天盈亏 —— 这是裁定的设计,不是 bug", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      // 中午充进 1 枚(价值 105):净值从此多了一笔**本金**
      await seedSnapshot(USER, acc.id, ago(DAY / 2), [{ tokenId: BTC, amount: 2, usdValue: 210 }]);
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 2, usdValue: 220 }]);
      await precompute();

      const out = await readPortfolio();

      // 旧口径(TWR)剔掉那 105 的本金、给 15;新口径就是 220 − 100 = 120,充值在里面。
      expect(out.portfolio?.amount).toBeCloseTo(120, 6);
      expect(out.holdings[BTC]?.amount).toBeCloseTo(120, 6);
      expect(out.portfolio?.pct).toBeCloseTo(120, 6); // 分母 = 起点值 100
    });

    it("账户不满 24 小时(唯一快照在 2 小时前)→ 全 null,不拿首张快照冒充基准", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(2 * HOUR), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
      await precompute();

      const out = await readPortfolio();

      expect(out.portfolio).toBeNull();
      for (const g of Object.values(out.holdings)) expect(g).toBeNull();
    });

    it("服务停摆过 → 就用手头最近的起点:10 天前那张,跨度更长但是真话", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(10 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
      await precompute();

      const out = await readPortfolio();

      // 旧口径这里是「算不出」;新口径没有特殊规则 —— 下一张整点快照落下它自己就校正。
      expect(out.portfolio?.amount).toBeCloseTo(30, 6);
      expect(out.holdings[BTC]?.amount).toBeCloseTo(30, 6);
    });

    it("起点值是 0 → 金额照给,百分比 null(没有分母)", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(DAY), []); // 有观测,但那时什么都没有
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
      await precompute();

      const out = await readPortfolio();

      expect(out.portfolio?.amount).toBeCloseTo(130, 6);
      expect(out.portfolio?.pct).toBeNull();
      // 这个币 24h 前不存在 → 起点 0:金额是全额,百分比 null。
      expect(out.holdings[BTC]?.amount).toBeCloseTo(130, 6);
      expect(out.holdings[BTC]?.pct).toBeNull();
    });

    it("DeFi 协议行:同一套两端相减,分母 = 起点净值(不再是总敞口)", async () => {
      const acc = await seedAccount(USER, "甲", "binance");
      const legs = (supply: number, borrow: number) => [
        {
          tokenId: BTC,
          amount: 1,
          usdValue: supply,
          kind: "defi" as const,
          meta: { protocol: "aave" },
        },
        {
          tokenId: ETH,
          amount: 1,
          usdValue: -borrow,
          kind: "defi" as const,
          meta: { protocol: "aave" },
        },
      ];
      await seedSnapshot(USER, acc.id, ago(DAY), legs(300, 200)); // 净 100
      await seedSnapshot(USER, acc.id, NOW, legs(330, 200)); // 净 130
      await precompute();

      const out = await readPortfolio();

      const key = `${acc.id}|aave`;
      expect(out.defi[key]?.amount).toBeCloseTo(30, 6);
      // 旧口径按总敞口(500)算是 6%;新口径分母 = 起点净值 100 → 30%。
      expect(out.defi[key]?.pct).toBeCloseTo(30, 6);
      expect(out.defi[key]?.basis).toBeCloseTo(100, 6);
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
      expect(out.portfolio?.amount).toBeCloseTo(10, 6);
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

      expect(Object.keys(out.holdings)).toEqual([BTC]);
      expect(out.holdings[BTC]?.amount).toBeCloseTo(40, 6);
    });

    it("一个账户有起点、另一个是今天新加的 → 新账户的现值整个算今天(与充值同一条裁定)", async () => {
      const old = await seedAccount(USER, "老", "bitcoin");
      await seedSnapshot(USER, old.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, old.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 110 }]);
      const fresh = await seedAccount(USER, "新", "binance");
      await seedSnapshot(USER, fresh.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 50 }]);
      await precompute();

      const out = await readPortfolio();

      expect(out.portfolio?.amount).toBeCloseTo(60, 6); // 10 的涨 + 50 的新进
      expect(out.holdings[ETH]?.amount).toBeCloseTo(50, 6);
      expect(out.holdings[ETH]?.pct).toBeNull(); // 起点 0,没有分母
    });

    it("全新用户 → 三个字段都空,不报错", async () => {
      const out = await readPortfolio();

      expect(out.portfolio).toBeNull();
      expect(out.holdings).toEqual({});
      expect(out.defi).toEqual({});
    });

    it("从没算过总览的组合(缓存冷)→ 空态;不 pending、不轮询,响应即终局", async () => {
      await seedTwoDays(); // 有数据,但没跑预计算

      const out = await readPortfolio();

      expect(out).toEqual({ portfolio: null, holdings: {}, defi: {} });
      expect("pending" in out).toBe(false);
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

    it("pin 那一份只装被它收窄的那些持仓,两端都按收窄后的账户集取", async () => {
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
      expect(pinned.portfolio?.amount).toBeCloseTo(10, 6); // 乙账户的 90 不掺进来
      expect(Object.keys(all.holdings).sort()).toEqual([BTC, ETH]);
    });

    // ADR 0049 的 10ms 预算靠这个成立:每次读固定几条查询,**与持币数无关**。
    // 断言两次读的查询数相等,而不是钉一个绝对数 —— 绝对数会让每次无关的重构都来改这条。
    it("查询数与持币数无关(O(1) per scope)", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 110 }]);
      await precompute();

      const countQueries = async () => {
        const spy = vi.spyOn(env.DB, "prepare");
        await readPortfolio();
        const n = spy.mock.calls.length;
        spy.mockRestore();
        return n;
      };
      const withOneToken = await countQueries();

      // 同一账户换成 12 个币的快照,再问一遍。
      const many = Array.from({ length: 12 }, (_, i) => ({
        tokenId: `token-${i}`,
        amount: 1,
        usdValue: 10,
      }));
      await seedSnapshot(USER, acc.id, ago(DAY) + 1, many);
      await seedSnapshot(USER, acc.id, NOW + 1, many);
      await precompute();
      const withManyTokens = await countQueries();

      expect(withOneToken).toBeGreaterThan(0);
      expect(withManyTokens).toBe(withOneToken);
    });
  });

  describe("getAccountGain24h —— 两端相减", () => {
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

      const out = await readAccounts();

      const rows = Object.values(out.balances).filter((g) => g != null);
      const sum = rows.reduce((s, g) => s + (g?.amount ?? 0), 0);
      expect(out.accounts[acc.id]?.amount).toBeCloseTo(40, 6);
      expect(out.accounts[acc.id]?.amount).toBeCloseTo(sum, 6);
    });

    it("同一个币散在多条链 —— 各行按市值占比摊分,加起来等于这个币的两端之差", async () => {
      const acc = await seedAccount(USER, "多链", "bitcoin");
      const legs = (a: number, b: number) => [
        { tokenId: BTC, amount: 60, usdValue: a, platform: "evm:1" },
        { tokenId: BTC, amount: 40, usdValue: b, platform: "evm:8453" },
      ];
      await seedSnapshot(USER, acc.id, ago(DAY), legs(60, 40));
      await seedSnapshot(USER, acc.id, NOW, legs(66, 44));

      const out = await readAccounts();

      const amounts = Object.values(out.balances).map((g) => g?.amount ?? 0);
      expect(amounts).toHaveLength(2);
      expect(amounts.reduce((s, x) => s + x, 0)).toBeCloseTo(10, 4);
      expect(Math.max(...amounts)).toBeCloseTo(6, 4);
      // 每行都认领全部的话,两行都会是 10、加起来 20。
      expect(Math.max(...amounts)).not.toBeCloseTo(10, 2);
    });

    it("归档账户 → 账户级和余额级都不出现", async () => {
      const archived = await seedAccount(USER, "归档", "bitcoin");
      await seedSnapshot(USER, archived.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, archived.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 900 }]);
      await db(USER).accounts.setArchived(archived.id, true);

      const out = await readAccounts();

      expect(out.accounts[archived.id]).toBeUndefined();
      expect(Object.keys(out.balances)).toEqual([]);
    });

    it("账户不满 24 小时 → null,不给 0", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(2 * HOUR), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

      const out = await readAccounts();

      expect(out.accounts[acc.id]).toBeNull();
      for (const g of Object.values(out.balances)) expect(g).toBeNull();
    });

    it("服务停摆过 → 就用手头最近的起点(10 天前),不判「算不出」", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await seedSnapshot(USER, acc.id, ago(10 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

      const out = await readAccounts();

      expect(out.accounts[acc.id]?.amount).toBeCloseTo(30, 6);
    });

    it("全新用户 → 两个字典都是空的", async () => {
      const out = await readAccounts();

      expect(out.accounts).toEqual({});
      expect(out.balances).toEqual({});
    });
  });

  // —— 手记账户:起点由账本折算(它不写快照,ADR 0018)——
  // 全用**未选币**的 token(不链上游)→ 不出网,价走账本(与 manual-grid 那组同一个手法)。
  describe("手记账户", () => {
    const bareManual = (label: string) =>
      db(USER).accounts.create({
        connectorId: "manual",
        label,
        creds: JSON.stringify({ tokens: "[]" }),
      });
    const buy = (amount: number, occurredAt: number) => ({
      token: { symbol: "BTC", unitPrice: 100 },
      kind: "add" as const,
      amount,
      occurredAt,
      price: 100,
    });

    it("账本早于 24 小时 → 起点 = 账本在那一刻的值;账户头与其现货行同源", async () => {
      const acc = await bareManual("老手记");
      // 开仓在三天前:起点值 = 2 × 100。
      await addManualActivities(USER, acc.id, [buy(2, ago(3 * DAY))]);

      const out = await readAccounts();

      // 现值也按账本价 100(未选币永远回不出市价)→ 两端相等,盈亏恰好 0 —— 不是 null。
      expect(out.accounts[acc.id]).toEqual({ amount: 0, pct: 0 });
      expect(out.balances[`manual:${acc.id}:0`]).toEqual({ amount: 0, pct: 0 });
    });

    it("手记账户不满 24 小时(账本第一笔就是刚才)→ null,与同步账户同一条规则", async () => {
      const acc = await seedManualAccount(USER, "新手记", {
        symbol: "BTC",
        unitPrice: 50_000,
        amount: 2,
      });

      const out = await readAccounts();

      expect(out.accounts[acc.id]).toBeNull();
      expect(out.balances[`manual:${acc.id}:0`]).toBeNull();

      // 组合级同一口径:唯一账户没有起点 → 全 null。
      await precompute();
      const portfolio = await readPortfolio();
      expect(portfolio.portfolio).toBeNull();
    });

    it("中途往手记里加币 → 计入当天盈亏(裁定):起点 200,现在 300", async () => {
      const acc = await bareManual("手记");
      // 三天前开仓 2 枚;今天上午又买 1 枚 —— 新口径里那一枚就是 +100。
      await addManualActivities(USER, acc.id, [buy(2, ago(3 * DAY)), buy(1, ago(2 * HOUR))]);

      const out = await readAccounts();

      expect(out.accounts[acc.id]?.amount).toBeCloseTo(100, 6);
      expect(out.accounts[acc.id]?.pct).toBeCloseTo(50, 6);
    });
  });

  // —— 前端贴回用的键:balances 的键就是持仓明细里那行的 id ——
  it("balances 的键与持仓明细的行 id 对得上(客户端按它贴回)", async () => {
    const acc = await seedAccount(USER, "甲", "bitcoin");
    await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

    const holdings = await call(USER, handleListAccountHoldings());
    const gain = await readAccounts();

    const rowIds = holdings.rows.flatMap((r) => r.balances.map((b) => b.id));
    expect(rowIds).toHaveLength(1);
    expect(gain.balances[rowIds[0]]?.amount).toBeCloseTo(30, 6);
  });
});
