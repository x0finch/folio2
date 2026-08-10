import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAccountHoldings } from "../../src/lib/server/internal/account-holdings";
import { runRequest } from "../../src/lib/server/internal/oracle";
import { dbFor } from "./db-effect";

// 归档 = 封存(ADR 0039):账户页的按账户明细**要包含归档账户**,显示的是封存那一刻的数。
//
// 为什么这条测试非落在真 D1 不可:它跨了账户、快照、manual 合成注入、富化四层,而「归档账户在不在
// 里面」正是跨层才看得出来的事 —— 隔壁 `scenarios.test.ts` 记着同一个教训(边界两侧各测一遍,
// 挡不住跨边界传错值)。
//
// 出网一律打桩成抛错:这条路径按设计不出网(价格取自快照与本地参考层),任何一次外呼都得看得见。
const USER = "user-account-holdings";

let outbound: string[] = [];

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    outbound.push(String(input));
    throw new Error(`本用例不该出网,却请求了 ${String(input)}`);
  });
});

afterEach(() => vi.restoreAllMocks());

const evmAccount = (label: string, address: string) =>
  dbFor(USER).accounts.create({
    connectorId: "evm",
    platform: "evm:1",
    label,
    creds: JSON.stringify({ address }),
  });

const rowsByLabel = async () => {
  const view = await runRequest(USER, loadAccountHoldings());
  return {
    view,
    of: (label: string) => view.rows.find((r) => r.account.label === label),
  };
};

describe("按账户明细与归档", () => {
  it("归档账户在里面,而且带着封存那一刻的市值与持仓", async () => {
    const btc = await dbFor(USER).transfer.importToken({ symbol: "BTC", name: "Bitcoin" }, [
      { namer: "coingecko", localName: "issued:bitcoin" },
    ]);
    const live = await evmAccount("Live", "0xlive");
    const gone = await evmAccount("Gone", "0xgone");
    await dbFor(USER).snapshots.write(live.id, {
      takenAt: 2000,
      totalUsd: 100,
      balances: [{ tokenId: btc, amount: 1, usdValue: 100, kind: "spot", platform: "evm:1" }],
    });
    await dbFor(USER).snapshots.write(gone.id, {
      takenAt: 1000,
      totalUsd: 42,
      balances: [{ tokenId: btc, amount: 0.5, usdValue: 42, kind: "spot", platform: "evm:1" }],
    });
    await dbFor(USER).accounts.setArchived(gone.id, true);

    const { of } = await rowsByLabel();

    // 这一条就是本片要的行为:归档账户不再是一具空壳。
    expect(of("Gone")?.totalUsd).toBe(42);
    expect(of("Gone")?.takenAt).toBe(1000);
    expect(of("Gone")?.balances).toHaveLength(1);
    expect(of("Gone")?.archivedAt).not.toBeNull();
    // 活跃账户不受影响。
    expect(of("Live")?.totalUsd).toBe(100);
    expect(of("Live")?.archivedAt).toBeNull();
    expect(outbound).toEqual([]);
  });

  it("归档账户没有快照(从没同步过就归档了)→ 退成空,但那一行仍在", async () => {
    const never = await evmAccount("NeverSynced", "0xnever");
    await dbFor(USER).accounts.setArchived(never.id, true);

    const { of } = await rowsByLabel();

    expect(of("NeverSynced")).toBeDefined();
    expect(of("NeverSynced")?.totalUsd).toBe(0);
    expect(of("NeverSynced")?.balances).toEqual([]);
  });

  // 刷价信号泄漏:只有归档账户还持有的币,不该让客户端每次进页白发一次批量刷价 ——
  // 而且刷完也不改它的显示值(封存值取自快照,不现推)。
  it("只有归档账户持有的币不会把刷价信号点亮", async () => {
    // 新 mint 的代币「有身份、无价」→ 富化会把它记成价格过期。让它只属于归档账户。
    const ghost = await dbFor(USER).transfer.importToken({ symbol: "GHOST", name: "Ghost" }, [
      { namer: "coingecko", localName: "issued:ghost" },
    ]);
    const gone = await evmAccount("Gone", "0xgone");
    await dbFor(USER).snapshots.write(gone.id, {
      takenAt: 1000,
      totalUsd: 10,
      balances: [{ tokenId: ghost, amount: 1, usdValue: 10, kind: "spot", platform: "evm:1" }],
    });
    await dbFor(USER).accounts.setArchived(gone.id, true);

    const { view, of } = await rowsByLabel();

    // 那一行自己仍然照实说「我这行的价过期了」——收窄发生在汇总那一步,不是把行的事实改掉。
    expect(of("Gone")?.pricesStale).toBe(true);
    expect(view.pricesStale).toBe(false);
  });

  it("活跃账户的币过期照旧点亮信号 —— 收窄不是把这件事整个关掉", async () => {
    const ghost = await dbFor(USER).transfer.importToken({ symbol: "GHOST2", name: "Ghost2" }, [
      { namer: "coingecko", localName: "issued:ghost2" },
    ]);
    const live = await evmAccount("Live", "0xlive");
    await dbFor(USER).snapshots.write(live.id, {
      takenAt: 1000,
      totalUsd: 10,
      balances: [{ tokenId: ghost, amount: 1, usdValue: 10, kind: "spot", platform: "evm:1" }],
    });

    const { view } = await rowsByLabel();

    expect(view.pricesStale).toBe(true);
  });
});

describe("账户行的 24h 盈亏(ADR 0040)", () => {
  // 与代币行同一套装配,只是**线按账户攒**而不是按币。这组打真 D1 是因为跨了账户、快照历史、
  // 富化三层 —— 尤其「归档账户拿到的是 undefined(不该有)而不是 null(算不出)」这个区分,
  // 只有走完整条链才看得出来。
  const DAY = 24 * 60 * 60 * 1000;

  const withHistory = async (label: string, address: string, then: number, nowValue: number) => {
    const btc = await dbFor(USER).transfer.importToken({ symbol: "BTC", name: "Bitcoin" }, [
      { namer: "coingecko", localName: `issued:${address}` },
    ]);
    const acc = await dbFor(USER).accounts.create({
      connectorId: "evm",
      platform: "evm:1",
      label,
      creds: JSON.stringify({ address }),
    });
    // 24 小时前那张(基准)
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: Date.now() - DAY,
      totalUsd: then,
      balances: [{ amount: 1, usdValue: then, kind: "spot", platform: "evm:1", tokenId: btc }],
    });
    // 最新那张(当下)
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: Date.now(),
      totalUsd: nowValue,
      balances: [{ amount: 1, usdValue: nowValue, kind: "spot", platform: "evm:1", tokenId: btc }],
    });
    return acc;
  };

  it("有基准 → 行上带真实盈亏", async () => {
    await withHistory("Live", "0xa", 100, 110);
    const { of } = await rowsByLabel();
    expect(of("Live")?.gain24h?.amount).toBeCloseTo(10, 4);
  });

  it("归档账户拿到 undefined —— 「不该有这个数」,不是「算不出」", async () => {
    const acc = await withHistory("Sealed", "0xb", 100, 110);
    await dbFor(USER).accounts.setArchived(acc.id, true);
    const { of } = await rowsByLabel();
    const row = of("Sealed");
    expect(row).toBeDefined(); // 归档账户仍在列表里(ADR 0039)
    expect(row?.gain24h).toBeUndefined();
    expect(row?.gain24h).not.toBeNull();
  });

  it("没有窗口内的基准 → null(界面渲染 `—`)", async () => {
    const btc = await dbFor(USER).transfer.importToken({ symbol: "ETH", name: "Ether" }, [
      { namer: "coingecko", localName: "issued:ethereum" },
    ]);
    const acc = await evmAccount("Fresh", "0xc");
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: Date.now(),
      totalUsd: 50,
      balances: [{ amount: 1, usdValue: 50, kind: "spot", platform: "evm:1", tokenId: btc }],
    });
    const { of } = await rowsByLabel();
    expect(of("Fresh")?.gain24h).toBeNull();
  });

  it("整条路径不出网", async () => {
    await withHistory("Quiet", "0xd", 100, 110);
    await rowsByLabel();
    expect(outbound).toEqual([]);
  });
});
