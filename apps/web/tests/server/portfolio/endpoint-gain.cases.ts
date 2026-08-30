import { beforeEach, describe, expect, it } from "vitest";
import { blockOutbound } from "../_kit/outbound";
import { readOverview } from "../_kit/run";
import { DAY, HOUR, seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser } from "../_kit/user";

// 24h 盈亏改成**两端相减**(ADR 0050 / FOL-51):`getPortfolioSnapshotData` 一次发当前 + 24 小时前
// 两组快照原料,浏览器 `overviewFromSnapshotData` 现值 − 24 小时前值算出来。这里打真 D1、走真链路
// (`readOverview` = 接口 + 客户端 select 那一行),按 FOL-43 定的规则逐条构造:
//   · 起点 = [now-7d, now-24h] 窗口内最近一张(`snapshots.asOf`);
//   · 账户不满 24 小时 → 起点空 → `—`(null);
//   · 断线超 7 天 → 起点空 → 该账户涨跌当 0,不虚增;
//   · 新账户/新买的币照常全算进组合(视同充值)。
describe("portfolio/endpoint-gain", () => {
  const USER = "h-pf-endpoint-gain";
  const BTC = "token-btc";
  const ETH = "token-eth";

  let NOW = 0;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    NOW = Date.now();
  });

  it("有起点 → 组合 / 持仓都两端相减(现值 − 24 小时前值)", async () => {
    const acc = await seedAccount(USER, "钱包", "bitcoin");
    await seedSnapshot(USER, acc.id, NOW - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

    const view = await readOverview(USER);
    expect(view.gain24h?.amount).toBeCloseTo(30, 6);
    expect(view.gain24h?.pct).toBeCloseTo(30, 6);
    const btc = view.holdings.find((h) => h.key === BTC);
    expect(btc?.gain24h?.amount).toBeCloseTo(30, 6);
    expect(btc?.gain24h?.pct).toBeCloseTo(30, 6);
  });

  it("整个组合都不满 24 小时(只有一张当下快照)→ 组合与持仓都 —(null)", async () => {
    const acc = await seedAccount(USER, "新号", "bitcoin");
    await seedSnapshot(USER, acc.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

    const view = await readOverview(USER);
    expect(view.gain24h).toBeNull();
    expect(view.holdings[0]?.gain24h).toBeNull();
  });

  it("新账户(不满 24h)与老账户混在一起 → 新账户全算进组合(视同充值)", async () => {
    const old = await seedAccount(USER, "老号", "bitcoin");
    await seedSnapshot(USER, old.id, NOW - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, old.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
    // 今天新建的账户:只有当下快照。
    const fresh = await seedAccount(USER, "新号", "binance");
    await seedSnapshot(USER, fresh.id, NOW, [{ tokenId: ETH, amount: 1, usdValue: 50 }]);

    const view = await readOverview(USER);
    // 起点 = 老号 100;现值 = 老号 130 + 新号 50 = 180 → +80。新号那 50 整份算成今天赚的。
    expect(view.gain24h?.amount).toBeCloseTo(80, 6);
    // ETH 是今天新买的 → 起点 0 → 整份算成今天赚的。
    expect(view.holdings.find((h) => h.key === ETH)?.gain24h?.amount).toBeCloseTo(50, 6);
  });

  it("断线超 7 天(窗口内无起点)→ 该账户涨跌当 0,不虚增组合", async () => {
    // 起点账户:正常两张(100 → 130,+30)。
    const live = await seedAccount(USER, "在线", "bitcoin");
    await seedSnapshot(USER, live.id, NOW - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, live.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
    // 断线账户:唯一那张快照在 8 天前(> 7 天),窗口内没有起点 → 不进盈亏。
    const stale = await seedAccount(USER, "断线", "binance");
    await seedSnapshot(USER, stale.id, NOW - 8 * DAY, [
      { tokenId: ETH, amount: 10, usdValue: 5000 },
    ]);

    const view = await readOverview(USER);
    // 组合盈亏只来自在线账户 +30;断线账户那 5000 既不当起点、也不当现值 → 当 0,不虚增。
    expect(view.gain24h?.amount).toBeCloseTo(30, 6);
    // 但断线账户的市值仍在总额里(总额口径不变,FOL-48)。
    expect(view.totalUsd).toBeCloseTo(130 + 5000, 6);
  });

  it("中断几天但仍在 7 天窗口内 → 顺延到窗口内最近那张当起点", async () => {
    const acc = await seedAccount(USER, "断了几天", "bitcoin");
    // 3 天前一张(在 [now-7d, now-24h] 窗口内)+ 现在一张,中间没有 24 小时那一刻的快照。
    await seedSnapshot(USER, acc.id, NOW - 3 * DAY, [{ tokenId: BTC, amount: 1, usdValue: 90 }]);
    await seedSnapshot(USER, acc.id, NOW - 2 * HOUR, [{ tokenId: BTC, amount: 1, usdValue: 120 }]);

    const view = await readOverview(USER);
    // 起点顺延到 3 天前那张(90),现值 120 → +30(跨度偏长但真实)。
    expect(view.gain24h?.amount).toBeCloseTo(30, 6);
  });
});
