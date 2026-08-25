import { beforeEach, describe, expect, it } from "vitest";
import { handleGetAccountGain24h, handleGetPortfolioGain24h } from "@/lib/server/portfolio/gain";
import { handleGetPortfolioOverview } from "@/lib/server/portfolio/overview";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { DAY, HOUR, seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

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

  it("基准点在容差之内(24h ± 2h)→ 算得出", async () => {
    const acc = await seedAccount(USER, "甲", "bitcoin");
    await seedSnapshot(USER, acc.id, ago(DAY + HOUR), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 120 }]);

    const out = await call(USER, handleGetPortfolioGain24h({}));

    expect(out.portfolio).not.toBeNull();
  });

  it("现值下跌 → 盈亏为负,符号不算反", async () => {
    const acc = await seedAccount(USER, "甲", "bitcoin");
    await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 40 }]);

    const out = await call(USER, handleGetPortfolioGain24h({}));

    expect(out.holdings[BTC]?.amount).toBeCloseTo(-60, 6);
    expect(out.portfolio?.amount).toBeCloseTo(-60, 6);
  });

  it("现值为负的那一行 → 从持仓列表里整个消失,而总额仍然含它", async () => {
    // **实测发现的一处不一致,已列入待定(#527)。** 我原以为负现值只是个普通差值
    // (100 → −50);实际那一行连 key 都不在 `holdings` 里 —— 不是 `null`,是不存在。
    //
    // 而总额 `totalUsd` **仍然算了这 −50**(见下面的断言)。于是屏幕上是这样:
    // 总净值少了 50,而持仓列表里没有任何一行能解释它去哪了。
    //
    // 为什么不直接算作 bug:负的现货余额本来就不该出现(现货不会欠账),它更像上游报了个
    // 怪数;把这种行从列表里剔掉是一种防御。但 perp 亏穿是真实场景,而「总额和明细对不上」
    // 是用户最会怀疑数据错了的那种不一致。要怎么办是产品决定,所以这里只把现状钉住。
    const acc = await seedAccount(USER, "永续", "hyperliquid");
    await seedSnapshot(USER, acc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: -50 }]);

    const gain = await call(USER, handleGetPortfolioGain24h({}));
    const view = await call(USER, handleGetPortfolioOverview({}));

    expect(Object.keys(gain.holdings)).not.toContain(BTC);
    expect(view.holdings.map((h) => h.key)).not.toContain(BTC);
    expect(view.totalUsd).toBe(-50); // 总额含它,列表没有它
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

  it("带 pin 收窄 → 只算圈进来的账户", async () => {
    const btcAcc = await seedAccount(USER, "链上", "bitcoin");
    await seedSnapshot(USER, btcAcc.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, btcAcc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 110 }]);
    const cexAcc = await seedAccount(USER, "交易所", "binance");
    await seedSnapshot(USER, cexAcc.id, ago(DAY), [{ tokenId: ETH, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, cexAcc.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 500 }]);

    const out = await call(
      USER,
      handleGetPortfolioGain24h({ pin: { kind: "connector", connectorId: "bitcoin" } }),
    );

    expect(Object.keys(out.holdings)).toEqual([BTC]);
  });

  it("手记账户 → 盈亏来自账本,充提不算赚", async () => {
    // 手记的盈亏走 `loadManualGainHistory`(账本),不是「现在总额 − 24 小时前总额」。
    // 建仓那一笔是充值性质的事实 —— 它不该被算成赚了一笔。
    await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 100, amount: 1 });

    const out = await call(USER, handleGetPortfolioGain24h({}));

    const gains = Object.values(out.holdings);
    for (const g of gains) {
      if (g != null) expect(g.amount).toBe(0);
    }
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

  it("别人的账户不出现在我的结果里", async () => {
    const theirs = await seedAccount(otherUser(USER), "他们的", "bitcoin");
    await seedSnapshot(otherUser(USER), theirs.id, NOW, [
      { tokenId: BTC, amount: 1, usdValue: 999 },
    ]);

    const out = await call(USER, handleGetAccountGain24h());

    expect(out.accounts[theirs.id]).toBeUndefined();
  });
});
