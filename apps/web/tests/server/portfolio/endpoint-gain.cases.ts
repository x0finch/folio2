import { beforeEach, describe, expect, it } from "vitest";
import { floorToHour } from "@/lib/core/portfolio";
import { blockOutbound } from "../_kit/outbound";
import { readOverview } from "../_kit/run";
import { DAY, seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser } from "../_kit/user";

// 24h 盈亏改成**两端相减**(ADR 0050 / FOL-51):原子 snapshots(现在 + 24 小时前)在浏览器
// `overviewFromSnapshotData` 里现值 − 24 小时前值算出来。这里打真 D1、走真链路
// (`readOverview` = 原子读 + 客户端 select 那一行),按 FOL-43 定的规则逐条构造:
//   · 起点 = [anchor-7d, anchor-24h] 窗口内最近一张(`getSnapshots` 的 at/after);
//   · anchor = hour-floor 的现在(FOL-54,与生产 query key 同口径);
//   · 账户不满 24 小时 → 起点空 → `—`(null);
//   · 断线超 7 天 → 起点空 → 该账户涨跌当 0,不虚增;
//   · 新账户/新买的币照常全算进组合(视同充值)。
describe("portfolio/endpoint-gain", () => {
  const USER = "h-pf-endpoint-gain";
  const BTC = "token-btc";
  const ETH = "token-eth";

  /** hour-floor 锚 —— 与 `readSnapshotData` / 生产 compose 同口径。 */
  let ANCHOR = 0;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    ANCHOR = floorToHour(Date.now());
  });

  it("有起点 → 组合 / 持仓都两端相减(现值 − 24 小时前值)", async () => {
    const acc = await seedAccount(USER, "钱包", "bitcoin");
    await seedSnapshot(USER, acc.id, ANCHOR - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, acc.id, ANCHOR, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

    const view = await readOverview(USER);
    expect(view.gain24h?.amount).toBeCloseTo(30, 6);
    expect(view.gain24h?.pct).toBeCloseTo(30, 6);
    const btc = view.holdings.find((h) => h.key === BTC);
    expect(btc?.gain24h?.amount).toBeCloseTo(30, 6);
    expect(btc?.gain24h?.pct).toBeCloseTo(30, 6);
  });

  it("整个组合都今天新建(无 24h 前基准)→ 组合与持仓都 —(null),不硬算", async () => {
    // 最终两档:无基准一律 `—`,新建 / 断线一视同仁(不再区分 new/stale、不再「起点 0 全额算涨」)。
    const acc = await seedAccount(USER, "新号", "bitcoin");
    await seedSnapshot(USER, acc.id, ANCHOR, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);

    const view = await readOverview(USER);
    expect(view.gain24h).toBeNull();
    expect(view.holdings[0]?.gain24h).toBeNull();
  });

  it("整个组合都断线超 7 天(无 24h 前基准)→ 同样是「无基准」→ 组合与持仓都 —(null)", async () => {
    const acc = await seedAccount(USER, "断线", "bitcoin");
    await seedSnapshot(USER, acc.id, ANCHOR - 8 * DAY, [
      { tokenId: BTC, amount: 1, usdValue: 130 },
    ]);

    const view = await readOverview(USER);
    expect(view.gain24h).toBeNull();
    expect(view.holdings[0]?.gain24h).toBeNull();
  });

  it("新账户(无基准)与老账户(有基准)混在一起 → 只算有基准的,新账户不进盈亏", async () => {
    const old = await seedAccount(USER, "老号", "bitcoin");
    await seedSnapshot(USER, old.id, ANCHOR - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, old.id, ANCHOR, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
    // 今天新建的账户:只有当下快照 → 无基准。
    const fresh = await seedAccount(USER, "新号", "binance");
    await seedSnapshot(USER, fresh.id, ANCHOR, [{ tokenId: ETH, amount: 1, usdValue: 50 }]);

    const view = await readOverview(USER);
    // 组合盈亏只来自有基准的老号:130 − 100 = +30。新号那 50 不当起点、也不当现值(无基准 → 不进)。
    expect(view.gain24h?.amount).toBeCloseTo(30, 6);
    expect(view.gain24h?.pct).toBeCloseTo(30, 6);
    // BTC 有基准 → +30;ETH 只在无基准的新账户里 → 没有可比起点 → `—`(null)。
    expect(view.holdings.find((h) => h.key === BTC)?.gain24h?.amount).toBeCloseTo(30, 6);
    expect(view.holdings.find((h) => h.key === ETH)?.gain24h).toBeNull();
    // 但两个账户的市值都在总额里(总额口径不变,FOL-48)。
    expect(view.totalUsd).toBeCloseTo(130 + 50, 6);
  });

  it("断线超 7 天(窗口内无起点)→ 该账户涨跌当 0,不虚增组合", async () => {
    // 起点账户:正常两张(100 → 130,+30)。
    const live = await seedAccount(USER, "在线", "bitcoin");
    await seedSnapshot(USER, live.id, ANCHOR - DAY, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, live.id, ANCHOR, [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
    // 断线账户:唯一那张快照在 8 天前(> 7 天),窗口内没有起点 → 不进盈亏。
    const stale = await seedAccount(USER, "断线", "binance");
    await seedSnapshot(USER, stale.id, ANCHOR - 8 * DAY, [
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
    // 3 天前一张(在 [anchor-7d, anchor-24h] 窗口内)+ 现在一张,中间没有 24 小时那一刻的快照。
    await seedSnapshot(USER, acc.id, ANCHOR - 3 * DAY, [{ tokenId: BTC, amount: 1, usdValue: 90 }]);
    await seedSnapshot(USER, acc.id, ANCHOR, [{ tokenId: BTC, amount: 1, usdValue: 120 }]);

    const view = await readOverview(USER);
    // 起点顺延到 3 天前那张(90),现值 120 → +30(跨度偏长但真实)。
    expect(view.gain24h?.amount).toBeCloseTo(30, 6);
  });
});
