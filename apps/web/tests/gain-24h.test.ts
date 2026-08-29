import { describe, expect, it } from "vitest";
import {
  buildGainLines,
  computeGain24h,
  GAIN_WINDOW_MS,
  type GainLine,
  type GainPoint,
} from "@/lib/core/portfolio";

// 24h 盈亏的口径(ADR 0040)。这组测试锁的是「剔除资金进出」这件事 —— 你买入卖出、充值提现
// 都不该被算成赚钱,而价格涨跌该被完整算到。

const NOW = 1_700_000_000_000;
const FROM = NOW - GAIN_WINDOW_MS;
const HOUR = 60 * 60 * 1000;

const line = (...points: GainPoint[]): GainLine => ({ points });
const p = (t: number, amount: number, value: number): GainPoint => ({ t, amount, value });

describe("ADR 0040 里那个基准例子", () => {
  // 24h 前 1 BTC @10.0 万;中午同步一次,BTC 10.5 万、同时发现变成 2 BTC;现在 BTC 11.0 万。
  const noon = FROM + 12 * HOUR;
  const btc = line(p(FROM, 1, 100_000), p(noon, 2, 210_000), p(NOW, 2, 220_000));

  it("金额 = 各段价值变动之和 = +1.5 万", () => {
    // 旧那个赚 1 万(10→11)+ 中午那个赚 5,000(10.5→11)。中午投进去的 10.5 万本金不算赚。
    expect(computeGain24h([btc], NOW)?.amount).toBeCloseTo(15_000, 6);
  });

  it("百分比 = 各段收益率连乘 = +10.0%,不是 15%", () => {
    const gain = computeGain24h([btc], NOW);
    // 1.0500 × 1.0476 − 1 = 10.0%
    expect(gain?.pct).toBeCloseTo(10, 4);
    // 简单除法(金额 ÷ 期初)会给 15% —— 中午加仓后本金变大,后半段那 1 万是靠 21 万赚的。
    // 这条断言是整件事的核心回归:它红了就说明分母又被算回期初价值了。
    const naive = (15_000 / 100_000) * 100;
    expect(gain?.pct).not.toBeCloseTo(naive, 1);
  });
});

describe("资金进出被剔除", () => {
  it("今天按现价新建的仓 —— 盈亏 0,而不是一整天的涨幅", () => {
    // 基准点是 (FROM, 0, 0):账户那时有快照,只是还没有这个币。
    const fresh = line(p(FROM, 0, 0), p(NOW, 1, 100_000));
    expect(computeGain24h([fresh], NOW)?.amount).toBe(0);
  });

  it("纯充值(价格一动没动)—— 盈亏 0", () => {
    const funded = line(p(FROM, 1, 100_000), p(FROM + HOUR, 2, 200_000), p(NOW, 2, 200_000));
    expect(computeGain24h([funded], NOW)?.amount).toBeCloseTo(0, 6);
  });

  it("价格没动但数量翻倍 —— 百分比也是 0,不是 100%", () => {
    const funded = line(p(FROM, 1, 100_000), p(FROM + HOUR, 2, 200_000), p(NOW, 2, 200_000));
    expect(computeGain24h([funded], NOW)?.pct).toBeCloseTo(0, 6);
  });

  it("卖光之后不凭空造盈亏 —— 不知道以什么价卖的,就记 0", () => {
    const sold = line(p(FROM, 2, 200_000), p(NOW, 0, 0));
    const gain = computeGain24h([sold], NOW);
    expect(gain?.amount).toBe(0);
    // 尤其不能把清仓读成「跌到 0」
    expect(gain?.amount).not.toBeCloseTo(-200_000, 0);
  });
});

describe("价格变化被完整算到", () => {
  it("没动过仓 —— 就是市值差", () => {
    const held = line(p(FROM, 1, 100_000), p(NOW, 1, 110_000));
    const gain = computeGain24h([held], NOW);
    expect(gain?.amount).toBeCloseTo(10_000, 6);
    expect(gain?.pct).toBeCloseTo(10, 6);
  });

  it("下跌方向正确", () => {
    const held = line(p(FROM, 1, 100_000), p(NOW, 1, 90_000));
    const gain = computeGain24h([held], NOW);
    expect(gain?.amount).toBeCloseTo(-10_000, 6);
    expect(gain?.pct).toBeCloseTo(-10, 6);
  });

  it("真的没涨没跌 —— 返回 0,不是 null", () => {
    const flat = line(p(FROM, 1, 100_000), p(NOW, 1, 100_000));
    const gain = computeGain24h([flat], NOW);
    expect(gain).not.toBeNull();
    expect(gain?.amount).toBe(0);
    expect(gain?.pct).toBeCloseTo(0, 6);
  });
});

describe("数据不够时的退化与留白", () => {
  it("窗口内只有头尾两点、中间数量变了 —— 按段初数量算,当天买卖那部分丢掉", () => {
    // 与基准例子同一笔账,但中午那次同步不存在。少了切口 → 只能算旧仓那 1 个的涨幅。
    const degraded = line(p(FROM, 1, 100_000), p(NOW, 2, 220_000));
    expect(computeGain24h([degraded], NOW)?.amount).toBeCloseTo(10_000, 6);
  });

  it("基准点太旧 —— 算不出,不拿三天前的数冒充 24 小时", () => {
    const stale = line(p(FROM - 3 * HOUR, 1, 100_000), p(NOW, 1, 110_000));
    expect(computeGain24h([stale], NOW)).toBeNull();
  });

  it("基准点在容差内 —— 算得出", () => {
    const nearly = line(p(FROM + HOUR, 1, 100_000), p(NOW, 1, 110_000));
    expect(computeGain24h([nearly], NOW)).not.toBeNull();
  });

  it("首点晚于窗口起点太多(新账户第一次同步)—— 算不出", () => {
    const brandNew = line(p(NOW - HOUR, 1, 100_000), p(NOW, 1, 110_000));
    expect(computeGain24h([brandNew], NOW)).toBeNull();
  });

  it("一条线都没有 —— 算不出", () => {
    expect(computeGain24h([], NOW)).toBeNull();
  });

  it("有基准的线与没基准的线混在一起 —— 只算有基准的那条", () => {
    const ok = line(p(FROM, 1, 100_000), p(NOW, 1, 110_000));
    const noBasis = line(p(NOW - HOUR, 1, 50_000), p(NOW, 1, 55_000));
    expect(computeGain24h([ok, noBasis], NOW)?.amount).toBeCloseTo(10_000, 6);
  });
});

describe("各行相加 = 组合那个数", () => {
  // 同一个函数两用:传单个 Holding 的各持有点 → 该行的数;传全部线 → 组合的数。
  // 「加得起来」因此是结构上成立的,不是两边各算一遍碰对。
  const a = line(p(FROM, 1, 100_000), p(FROM + 6 * HOUR, 1, 105_000), p(NOW, 1, 110_000));
  const b = line(p(FROM, 10, 30_000), p(FROM + 9 * HOUR, 20, 62_000), p(NOW, 20, 58_000));

  it("金额可加", () => {
    const total = computeGain24h([a, b], NOW);
    const each = [a, b].map((l) => computeGain24h([l], NOW)?.amount ?? 0);
    expect(total?.amount).toBeCloseTo(each[0] + each[1], 6);
  });

  it("百分比不可加 —— 组合的是统一时间轴上的连乘,不是各行取平均", () => {
    const total = computeGain24h([a, b], NOW);
    const avg =
      [a, b].map((l) => computeGain24h([l], NOW)?.pct ?? 0).reduce((x, y) => x + y, 0) / 2;
    expect(total?.pct).not.toBeCloseTo(avg, 6);
  });

  it("各线切口不同也对齐到同一根轴", () => {
    // a 的切口在 +6h、b 的在 +9h;组合层要在两个切口都切,否则会漏掉 b 加仓前后的分界。
    const total = computeGain24h([a, b], NOW);
    expect(total).not.toBeNull();
    expect(Number.isFinite(total?.amount ?? Number.NaN)).toBe(true);
  });
});

describe("没有「数量」可依的行(DeFi / 永续权益)", () => {
  // ADR 0040 的已知妥协:这两类只有一个总价值,把数量恒定为 1 喂进来 → 自动退化成两张照片的
  // 价值相减,不需要第二套逻辑。代价是你往里加钱那天会虚高,那是写在明处的。
  it("数量恒为 1 时就是价值差", () => {
    const lp = line(p(FROM, 1, 50_000), p(NOW, 1, 52_000));
    expect(computeGain24h([lp], NOW)?.amount).toBeCloseTo(2_000, 6);
  });

  it("净负债(价值为负)不把整条链的符号搞反", () => {
    const debt = line(p(FROM, 1, -10_000), p(NOW, 1, -9_000));
    const gain = computeGain24h([debt], NOW);
    // 欠得少了是赚
    expect(gain?.amount).toBeCloseTo(1_000, 6);
    // 分母 ≤ 0 的段不进连乘 → 没有可信的百分比可给
    expect(gain?.pct).toBeNull();
  });
});

describe("从快照历史装配持仓线", () => {
  const A = "acct-a";
  const B = "acct-b";
  const BTC = "tok-btc";
  const ETH = "tok-eth";
  const h = (
    accountId: string,
    takenAt: number,
    tokenId: string,
    amount: number,
    usdValue: number,
  ) => ({
    accountId,
    takenAt,
    tokenId,
    amount,
    usdValue,
  });

  it("同账户同币的多行(多链 / 多 Wallet)先合并成一条线", () => {
    const lines = buildGainLines(
      [h(A, FROM, BTC, 0.5, 50_000), h(A, FROM, BTC, 0.5, 50_000)],
      [
        { accountId: A, tokenId: BTC, amount: 0.5, value: 55_000 },
        { accountId: A, tokenId: BTC, amount: 0.5, value: 55_000 },
      ],
      NOW,
    );
    expect(lines.get(BTC)).toHaveLength(1);
    expect(lines.get(BTC)?.[0].points[0]).toMatchObject({ amount: 1, value: 100_000 });
  });

  it("快照里没有这个币 → 补 0 点,不让阶梯取值把清仓读成还持有", () => {
    // FROM 那张快照有 BTC,后一张只有 ETH —— BTC 在那一刻已经是 0。
    const lines = buildGainLines(
      [h(A, FROM, BTC, 1, 100_000), h(A, FROM + HOUR, ETH, 10, 30_000)],
      [{ accountId: A, tokenId: ETH, amount: 10, value: 31_000 }],
      NOW,
    );
    const btc = lines.get(BTC)?.[0].points ?? [];
    expect(btc.find((pt) => pt.t === FROM + HOUR)).toMatchObject({ amount: 0, value: 0 });
  });

  it("今天新建的仓 —— 账户那时有快照,基准点是 0,于是盈亏 0", () => {
    const lines = buildGainLines(
      [h(A, FROM, ETH, 10, 30_000)],
      [
        { accountId: A, tokenId: ETH, amount: 10, value: 30_000 },
        { accountId: A, tokenId: BTC, amount: 1, value: 100_000 },
      ],
      NOW,
    );
    expect(computeGain24h(lines.get(BTC) ?? [], NOW)?.amount).toBe(0);
  });

  it("末点补当下 —— 一天只同步一次时,今天的涨跌全靠它", () => {
    const lines = buildGainLines(
      [h(A, FROM, BTC, 1, 100_000)],
      [{ accountId: A, tokenId: BTC, amount: 1, value: 110_000 }],
      NOW,
    );
    expect(computeGain24h(lines.get(BTC) ?? [], NOW)?.amount).toBeCloseTo(10_000, 6);
  });

  it("同一个币跨账户 → 多条线,归到同一个分组键下", () => {
    const lines = buildGainLines(
      [h(A, FROM, BTC, 1, 100_000), h(B, FROM, BTC, 2, 200_000)],
      [
        { accountId: A, tokenId: BTC, amount: 1, value: 110_000 },
        { accountId: B, tokenId: BTC, amount: 2, value: 220_000 },
      ],
      NOW,
    );
    expect(lines.get(BTC)).toHaveLength(2);
    expect(computeGain24h(lines.get(BTC) ?? [], NOW)?.amount).toBeCloseTo(30_000, 6);
  });

  it("没有 token_id 的旧行归不了组 —— 不产线", () => {
    const lines = buildGainLines(
      [{ accountId: A, takenAt: FROM, tokenId: null, amount: 1, usdValue: 100 }],
      [{ accountId: A, tokenId: null, amount: 1, value: 110 }],
      NOW,
    );
    expect(lines.size).toBe(0);
  });

  it("一个账户没有窗口起点附近的快照 —— 它那条线算不出,不拖累别的账户", () => {
    const lines = buildGainLines(
      [h(A, FROM, BTC, 1, 100_000), h(B, NOW - HOUR, BTC, 5, 500_000)],
      [
        { accountId: A, tokenId: BTC, amount: 1, value: 110_000 },
        { accountId: B, tokenId: BTC, amount: 5, value: 550_000 },
      ],
      NOW,
    );
    // B 的首点是 NOW-1h,离窗口起点 23 小时 → 无效;只有 A 那条参与。
    expect(computeGain24h(lines.get(BTC) ?? [], NOW)?.amount).toBeCloseTo(10_000, 6);
  });
});

describe("同一账户同一个币分散在多条链 —— 抽屉里那几行加起来仍是这个币的总盈亏", () => {
  // 抽屉的现货区按 balance 行渲染(多链 = 多行),而线是按 (账户 × 币) 的一条。整体金额按各行
  // 市值占比摊回去,于是逐行显示与「这个币一共赚了多少」对得上,不会重复计数。
  it("按市值占比摊分之后总和不变", () => {
    const A = "acct";
    const USDC = "tok-usdc";
    const lines = buildGainLines(
      [
        { accountId: A, takenAt: FROM, tokenId: USDC, amount: 60, usdValue: 60 },
        { accountId: A, takenAt: FROM, tokenId: USDC, amount: 40, usdValue: 40 },
      ],
      [
        { accountId: A, tokenId: USDC, amount: 60, value: 66 },
        { accountId: A, tokenId: USDC, amount: 40, value: 44 },
      ],
      NOW,
    );
    const total = computeGain24h(lines.get(USDC) ?? [], NOW);
    expect(total?.amount).toBeCloseTo(10, 6);
    // 摊分:66/110 与 44/110
    const split = [66, 44].map((v) => (total?.amount ?? 0) * (v / 110));
    expect(split[0] + split[1]).toBeCloseTo(total?.amount ?? 0, 6);
    expect(split[0]).toBeCloseTo(6, 6);
  });
});

describe("摊开给用户看的分段(#445)", () => {
  it("没动过手 → 只有一段,而且它的除法自己就对得上", () => {
    const held = line(p(FROM, 1, 100_000), p(FROM + 6 * HOUR, 1, 105_000), p(NOW, 1, 110_000));
    const gain = computeGain24h([held], NOW);
    // 中间那个观测点不是「你动过手」,合并掉 —— 逐段列出来只是价格在慢慢爬,没有信息量。
    expect(gain?.segments).toHaveLength(1);
    expect(gain?.segments[0].gain).toBeCloseTo(10_000, 6);
    // 一段的时候金额 ÷ 期初 == 百分比,除得通
    expect((gain?.segments[0].gain ?? 0) / (gain?.segments[0].openValue ?? 1)).toBeCloseTo(
      (gain?.pct ?? 0) / 100,
      6,
    );
  });

  it("买卖过 → 在你动手那一刻切开,而且正是除不通的那种情形", () => {
    const noon = FROM + 12 * HOUR;
    const btc = line(p(FROM, 1, 100_000), p(noon, 2, 210_000), p(NOW, 2, 220_000));
    const gain = computeGain24h([btc], NOW);
    expect(gain?.segments).toHaveLength(2);
    expect(gain?.segments[0].openedByChange).toBe(false);
    expect(gain?.segments[1].openedByChange).toBe(true); // 中午那一刻数量变了
    expect(gain?.segments[0].gain).toBeCloseTo(5_000, 6);
    expect(gain?.segments[1].gain).toBeCloseTo(10_000, 6);
    // 各段收益率 +5.00% 与 +4.76%:连乘得 10%,直接相加是 9.76% —— 弹层要展示的正是这个差别
    expect(gain?.segments[0].pct).toBeCloseTo(5, 4);
    expect(gain?.segments[1].pct).toBeCloseTo((10_000 / 210_000) * 100, 4);
  });

  it("各段金额之和 = 总金额", () => {
    const noon = FROM + 12 * HOUR;
    const btc = line(p(FROM, 1, 100_000), p(noon, 2, 210_000), p(NOW, 2, 220_000));
    const gain = computeGain24h([btc], NOW);
    const sum = (gain?.segments ?? []).reduce((s, x) => s + x.gain, 0);
    expect(sum).toBeCloseTo(gain?.amount ?? 0, 6);
  });

  it("合并段的百分比是重算的,不是把各段百分比加起来", () => {
    // 三个连续的、没动过手的观测点 → 合成一段。把 +5% 与 +2.86% 与 +1.85% 直接相加会偏,
    // 而正确答案是 (110000−100000)/100000 = 10%。
    const held = line(
      p(FROM, 1, 100_000),
      p(FROM + 6 * HOUR, 1, 105_000),
      p(FROM + 12 * HOUR, 1, 108_000),
      p(NOW, 1, 110_000),
    );
    const gain = computeGain24h([held], NOW);
    expect(gain?.segments).toHaveLength(1);
    expect(gain?.segments[0].pct).toBeCloseTo(10, 6);
  });
});
