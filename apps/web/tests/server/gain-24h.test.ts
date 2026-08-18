import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildGainLines,
  computeGain24h,
  GAIN_BASIS_TOLERANCE_MS,
  GAIN_WINDOW_MS,
} from "../../src/lib/server/internal/gain-24h";
import { dbFor } from "./db-effect";

// 24h 盈亏的**取数**那一半(ADR 0040)。算法本身在 `tests/gain-24h.test.ts` 里穷尽过了;这里打真 D1,
// 验的是另一件事:`listBalanceHistory` 吐出来的行,装配成持仓线之后确实是对的。
//
// 为什么非要真 D1 —— 这条链上有两个只有跨层才看得出来的地方:
//   · 窗口下界必须比「24 小时前」再往前留一个容差,否则基准快照恰好落在窗口外时整条线判「算不出」,
//     而它明明就在库里;
//   · 同一账户同一个币可能落成**多行**(多链 / 多 Wallet),装配时不合并就会变成几条互相打架的线。
// 两者都在纯函数的桩数据里很容易「碰巧对」,只有让真查询跑一遍才作数。
const USER = "user-gain-24h";
const NOW = 1_700_000_000_000;
const FROM = NOW - GAIN_WINDOW_MS;
const HOUR = 60 * 60 * 1000;
const SINCE = NOW - GAIN_WINDOW_MS - GAIN_BASIS_TOLERANCE_MS;

const db = () => dbFor(USER);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
});

// 直接建账户行(不经 connector):这组只关心快照历史怎么回来,建账户的路径别处已经测透。
async function account(id: string, label: string): Promise<string> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO accounts (id, user_id, connector_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, USER, "evm", label, now)
    .run();
  return id;
}

const spot = (tokenId: string, amount: number, usdValue: number, platform = "evm:1") => ({
  amount,
  usdValue,
  kind: "spot" as const,
  platform,
  tokenId,
});

describe("从真 D1 的余额历史装配持仓线", () => {
  it("窗口内两张快照 → 盈亏 = 价格那一段涨的", async () => {
    const a = await account("acc-1", "Arb");
    await db().snapshots.write(a, {
      takenAt: FROM,
      totalUsd: 100,
      balances: [spot("tok-btc", 1, 100)],
    });

    const history = await db().snapshots.listBalanceHistory(SINCE);
    const lines = buildGainLines(
      history,
      [{ accountId: a, tokenId: "tok-btc", amount: 1, value: 110 }],
      NOW,
    );
    expect(computeGain24h(lines.get("tok-btc") ?? [], NOW)?.amount).toBeCloseTo(10, 6);
  });

  it("基准快照落在窗口起点之前一点 —— 容差要接得住,不能判成算不出", async () => {
    const a = await account("acc-2", "Arb");
    // 比「24 小时前」再早一小时:同步不会正好卡在那一刻,这是常态而非边缘情况。
    await db().snapshots.write(a, {
      takenAt: FROM - HOUR,
      totalUsd: 100,
      balances: [spot("tok-btc", 1, 100)],
    });

    const history = await db().snapshots.listBalanceHistory(SINCE);
    expect(history).toHaveLength(1); // 下界留了容差,这行才捞得回来
    const lines = buildGainLines(
      history,
      [{ accountId: a, tokenId: "tok-btc", amount: 1, value: 110 }],
      NOW,
    );
    expect(computeGain24h(lines.get("tok-btc") ?? [], NOW)?.amount).toBeCloseTo(10, 6);
  });

  it("同一账户同一个币落成多行(多链)—— 合并成一条线,而不是几条打架的线", async () => {
    const a = await account("acc-3", "Multi");
    await db().snapshots.write(a, {
      takenAt: FROM,
      totalUsd: 100,
      balances: [spot("tok-usdc", 60, 60, "evm:1"), spot("tok-usdc", 40, 40, "evm:8453")],
    });

    const history = await db().snapshots.listBalanceHistory(SINCE);
    expect(history).toHaveLength(2); // 库里确实是两行
    const lines = buildGainLines(
      history,
      [
        { accountId: a, tokenId: "tok-usdc", amount: 60, value: 66 },
        { accountId: a, tokenId: "tok-usdc", amount: 40, value: 44 },
      ],
      NOW,
    );
    expect(lines.get("tok-usdc")).toHaveLength(1); // 装配成一条
    expect(computeGain24h(lines.get("tok-usdc") ?? [], NOW)?.amount).toBeCloseTo(10, 6);
  });

  it("窗口内多张快照 → 逐段切,当天加仓的本金不算成赚", async () => {
    const a = await account("acc-4", "Arb");
    await db().snapshots.write(a, {
      takenAt: FROM,
      totalUsd: 100_000,
      balances: [spot("tok-btc", 1, 100_000)],
    });
    // 中午同步:币价 10.5 万,同时发现变成 2 枚(你在这中间买了一枚)
    await db().snapshots.write(a, {
      takenAt: FROM + 12 * HOUR,
      totalUsd: 210_000,
      balances: [spot("tok-btc", 2, 210_000)],
    });

    const history = await db().snapshots.listBalanceHistory(SINCE);
    const lines = buildGainLines(
      history,
      [{ accountId: a, tokenId: "tok-btc", amount: 2, value: 220_000 }],
      NOW,
    );
    const gain = computeGain24h(lines.get("tok-btc") ?? [], NOW);
    // 旧那枚赚 1 万 + 中午那枚赚 5,000;中午投进去的 10.5 万本金不算
    expect(gain?.amount).toBeCloseTo(15_000, 6);
    expect(gain?.pct).toBeCloseTo(10, 4);
  });

  it("某张快照里这个币不见了(清仓)→ 补 0 点,不把它读成还持有", async () => {
    const a = await account("acc-5", "Arb");
    await db().snapshots.write(a, {
      takenAt: FROM,
      totalUsd: 100,
      balances: [spot("tok-btc", 1, 100)],
    });
    await db().snapshots.write(a, {
      takenAt: FROM + HOUR,
      totalUsd: 30,
      balances: [spot("tok-eth", 10, 30)],
    });

    const history = await db().snapshots.listBalanceHistory(SINCE);
    const lines = buildGainLines(
      history,
      [{ accountId: a, tokenId: "tok-eth", amount: 10, value: 31 }],
      NOW,
    );
    const btc = lines.get("tok-btc")?.[0].points ?? [];
    expect(btc.find((pt) => pt.t === FROM + HOUR)).toMatchObject({ amount: 0, value: 0 });
    // 清仓不该被读成「跌到 0」
    expect(computeGain24h(lines.get("tok-btc") ?? [], NOW)?.amount).toBe(0);
  });

  it("窗口外的快照不参与 —— 三天前的数不能冒充 24 小时", async () => {
    const a = await account("acc-6", "Stale");
    await db().snapshots.write(a, {
      takenAt: NOW - 3 * GAIN_WINDOW_MS,
      totalUsd: 100,
      balances: [spot("tok-btc", 1, 100)],
    });

    const history = await db().snapshots.listBalanceHistory(SINCE);
    expect(history).toEqual([]); // 查询就把它挡在外面了
    const lines = buildGainLines(
      history,
      [{ accountId: a, tokenId: "tok-btc", amount: 1, value: 110 }],
      NOW,
    );
    // 只剩一个当下点,没有基准 → 算不出
    expect(computeGain24h(lines.get("tok-btc") ?? [], NOW)).toBeNull();
  });

  it("跨用户不串 —— 历史按 userId 作用域", async () => {
    const a = await account("acc-7", "Mine");
    await db().snapshots.write(a, {
      takenAt: FROM,
      totalUsd: 100,
      balances: [spot("tok-btc", 1, 100)],
    });
    const other = await dbFor("someone-else").snapshots.listBalanceHistory(SINCE);
    expect(other).toEqual([]);
  });
});
