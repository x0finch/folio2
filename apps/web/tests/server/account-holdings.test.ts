import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAccountHoldings } from "../../src/lib/server/internal/account-holdings";
import { runRequest } from "../../src/lib/server/internal/oracle";
import { dbFor } from "./db-effect";
import { addManualActivities } from "./manual-fns";

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

describe("抽屉现货行的逐币盈亏(ADR 0040)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("同一个币散在多条链 —— 各行加起来等于这个币的总盈亏,不是每行都认领全部", async () => {
    const usdc = await dbFor(USER).transfer.importToken({ symbol: "USDC", name: "USD Coin" }, [
      { namer: "coingecko", localName: "issued:usd-coin" },
    ]);
    const acc = await dbFor(USER).accounts.create({
      connectorId: "evm",
      platform: "evm:1",
      label: "Multi",
      creds: JSON.stringify({ address: "0xmulti" }),
    });
    // **数量固定,只有市值变** —— 数量也跟着变的话这就成了「加仓」,按剔除资金进出的口径
    // 盈亏正是 0(算法没错,是夹具会写错的地方)。
    const legs = (a: number, b: number) => [
      { amount: 60, usdValue: a, kind: "spot" as const, platform: "evm:1", tokenId: usdc },
      { amount: 40, usdValue: b, kind: "spot" as const, platform: "evm:8453", tokenId: usdc },
    ];
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: Date.now() - DAY,
      totalUsd: 100,
      balances: legs(60, 40),
    });
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: Date.now(),
      totalUsd: 110,
      balances: legs(66, 44),
    });

    const { of } = await rowsByLabel();
    const rows = of("Multi")?.balances ?? [];
    expect(rows).toHaveLength(2);
    const amounts = rows.map((b) => b.gain24h?.amount ?? 0);
    // 该币一共赚了 10;两行按 66/110 与 44/110 摊分 → 6 与 4
    expect(amounts.reduce((s, x) => s + x, 0)).toBeCloseTo(10, 4);
    expect(Math.max(...amounts)).toBeCloseTo(6, 4);
    // 每行都认领全部的话,两行都会是 10、加起来 20
    expect(Math.max(...amounts)).not.toBeCloseTo(10, 2);
  });

  it("归档账户的现货行不带这个数", async () => {
    const acc = await withHistoryAccount("Sealed2", "0xz");
    await dbFor(USER).accounts.setArchived(acc.id, true);
    const { of } = await rowsByLabel();
    expect(of("Sealed2")?.balances[0]?.gain24h).toBeUndefined();
  });
});

async function withHistoryAccount(label: string, address: string) {
  const DAY = 24 * 60 * 60 * 1000;
  const tok = await dbFor(USER).transfer.importToken({ symbol: "SOL", name: "Solana" }, [
    { namer: "coingecko", localName: `issued:${address}` },
  ]);
  const acc = await dbFor(USER).accounts.create({
    connectorId: "evm",
    platform: "evm:1",
    label,
    creds: JSON.stringify({ address }),
  });
  for (const [t, v] of [
    [Date.now() - DAY, 100],
    [Date.now(), 110],
  ] as const) {
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: t,
      totalUsd: v,
      balances: [{ amount: 1, usdValue: v, kind: "spot", platform: "evm:1", tokenId: tok }],
    });
  }
  return acc;
}

describe("manual 账户的抽屉现货行", () => {
  // 浏览器实测发现:抽屉头显示 −$1,524.85,而它下面唯一那行 BTC 却是 `—` —— 同一个账户同一个币,
  // 两个数打架。账户级和逐币级用的是同一份原料、同一个装配,不该有一个算得出、另一个算不出。
  const DAY = 24 * 60 * 60 * 1000;
  const localBtc = { symbol: "BTC", unitPrice: 100 };

  it("账户头算得出时,它下面那行也算得出 —— 两者同源", async () => {
    const acc = await dbFor(USER).accounts.create({
      connectorId: "manual",
      label: "M1",
      creds: JSON.stringify({ tokens: "[]" }),
    });
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 2, occurredAt: Date.now() - 3 * DAY, price: 100 },
    ]);

    const { of } = await rowsByLabel();
    const row = of("M1");
    expect(row?.gain24h).not.toBeUndefined();
    expect(row?.gain24h).not.toBeNull(); // 账户头算得出
    expect(row?.balances).toHaveLength(1);
    // 这一条就是浏览器里看到的那个矛盾
    expect(row?.balances[0].gain24h).not.toBeNull();
  });

  it("两个 manual 账户持有同一个币(共用 token_id)—— 各自的行互不串", async () => {
    const mk = async (label: string) => {
      const a = await dbFor(USER).accounts.create({
        connectorId: "manual",
        label,
        creds: JSON.stringify({ tokens: "[]" }),
      });
      await addManualActivities(USER, a.id, [
        { token: localBtc, kind: "add", amount: 2, occurredAt: Date.now() - 3 * DAY, price: 100 },
      ]);
      return a;
    };
    await mk("MA");
    await mk("MB");

    const { of } = await rowsByLabel();
    for (const label of ["MA", "MB"]) {
      expect(of(label)?.balances[0]?.gain24h, label).not.toBeNull();
    }
  });
});
