import { env } from "cloudflare:test";
import type { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "@/lib/server/errors";
import { loadAccountHoldings } from "@/lib/server/portfolio/account-holdings";
import { runForUser, type UserServices } from "@/lib/server/runtime";
import { dbFor } from "./db-effect";
import { addManualActivities } from "./manual-fns";

// 归档 = 封存(ADR 0039):账户页的按账户明细**要包含归档账户**,显示的是封存那一刻的数。
//
// 为什么这条测试非落在真 D1 不可:它跨了账户、快照、manual 合成注入、富化四层,而「归档账户在不在
// 里面」正是跨层才看得出来的事 —— 隔壁 `scenarios.test.ts` 记着同一个教训(边界两侧各测一遍,
// 挡不住跨边界传错值)。
//
// 出网一律打桩成抛错:这条路径按设计不出网(价格取自快照与本地参考层),任何一次外呼都得看得见。
// **#527 后续件 4:五条同层同保真度的用例摘去了新家** —— 「归档在列表里且值停封存」「默认路径
// 不算盈亏」「归档拿 undefined(账户级与现货行)」「没基准给 null」现在住 `portfolio/
// account-holdings.test.ts` 与 `portfolio/gain.test.ts`(同一个 runForUser + 真 D1,断言相同)。
// 留在这里的都是那边没有的:跨链盈亏摊分、manual 与同步账户共用 token_id、刷价信号。
const USER = "user-account-holdings";

// 生产那条路的把手 —— 底下就是 server fn / 路由用的那个内核(#504 T13)。
const run = <A, E extends AppError, R extends UserServices>(
  userId: string,
  effect: Effect.Effect<A, E, R>,
): Promise<A> => runForUser(userId, effect);

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

const rowsByLabel = async (withGain = false) => {
  const view = await run(USER, loadAccountHoldings(withGain));
  return {
    view,
    of: (label: string) => view.rows.find((r) => r.account.label === label),
  };
};

describe("按账户明细与归档", () => {
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
    const { of } = await rowsByLabel(true);
    expect(of("Live")?.gain24h?.amount).toBeCloseTo(10, 4);
  });

  it("整条路径不出网", async () => {
    await withHistory("Quiet", "0xd", 100, 110);
    await rowsByLabel(true);
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

    const { of } = await rowsByLabel(true);
    const rows = of("Multi")?.balances ?? [];
    expect(rows).toHaveLength(2);
    const amounts = rows.map((b) => b.gain24h?.amount ?? 0);
    // 该币一共赚了 10;两行按 66/110 与 44/110 摊分 → 6 与 4
    expect(amounts.reduce((s, x) => s + x, 0)).toBeCloseTo(10, 4);
    expect(Math.max(...amounts)).toBeCloseTo(6, 4);
    // 每行都认领全部的话,两行都会是 10、加起来 20
    expect(Math.max(...amounts)).not.toBeCloseTo(10, 2);
  });
});

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

    const { of } = await rowsByLabel(true);
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

    const { of } = await rowsByLabel(true);
    for (const label of ["MA", "MB"]) {
      expect(of(label)?.balances[0]?.gain24h, label).not.toBeNull();
    }
  });
});

describe("复刻真实数据的形状:manual 与同步账户混在一起", () => {
  // 浏览器实测里那个矛盾(抽屉头有数、其下现货行 `—`)在前面两条简化用例上复现不出来。
  // 真实环境比它们多三样东西,这里一次全给上:
  //   ① 一堆**带快照**的同步账户,而且其中一个持有同一个币(用户级 token_id,ADR 0021 → 同一个 id)
  //   ② 那些快照的时刻**都落在容差之外**(29.9h / 17.5h),于是同步账户一律算不出
  //   ③ manual 账户的账本活动也在窗口之外(128h 前),只能靠窗口起点那个合成基准点
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 3600_000;
  const localBtc = { symbol: "BTC", unitPrice: 63921 };

  it("同步账户全 `—`,manual 账户头与其现货行**同时**算得出", async () => {
    const now = Date.now();
    // ① 同步账户:两张快照,29.9h 与 17.5h —— 都不在 22–26h 内
    const btc = await dbFor(USER).transfer.importToken({ symbol: "BTC", name: "Bitcoin" }, [
      { namer: "coingecko", localName: "issued:bitcoin" },
    ]);
    const synced = await evmAccount("Synced", "0xsynced");
    for (const [t, v] of [
      [now - 29.9 * HOUR, 900_000],
      [now - 17.5 * HOUR, 958_000],
    ] as const) {
      await dbFor(USER).snapshots.write(synced.id, {
        takenAt: t,
        totalUsd: v,
        balances: [{ amount: 14, usdValue: v, kind: "spot", platform: "evm:1", tokenId: btc }],
      });
    }

    // ② 两个 manual 账户,活动都在 128 小时前,持有同一个币
    const manuals: string[] = [];
    for (const label of ["xxx", "a"]) {
      const m = await dbFor(USER).accounts.create({
        connectorId: "manual",
        label,
        creds: JSON.stringify({ tokens: "[]" }),
      });
      await addManualActivities(USER, m.id, [
        { token: localBtc, kind: "add", amount: 2, occurredAt: now - 128 * HOUR, price: 63921 },
      ]);
      manuals.push(label);
    }

    const { of } = await rowsByLabel(true);

    // 同步账户:基准落在容差外 → 算不出(这部分是 #455 记的口径问题,不是 bug)
    expect(of("Synced")?.gain24h).toBeNull();

    for (const label of manuals) {
      const row = of(label);
      // 抽屉头这个数
      expect(row?.gain24h, `${label} 账户头`).not.toBeNull();
      expect(row?.gain24h, `${label} 账户头`).not.toBeUndefined();
      // 它下面那一行 —— 浏览器里就是这里显示的 `—`
      expect(row?.balances, `${label} 有持仓行`).toHaveLength(1);
      expect(row?.balances[0]?.gain24h, `${label} 现货行`).not.toBeNull();
      expect(row?.balances[0]?.gain24h, `${label} 现货行`).not.toBeUndefined();
    }
  });

  it("manual 与同步账户持有同一个 token_id —— 两边的线不串", async () => {
    const now = Date.now();
    const btc = await dbFor(USER).transfer.importToken({ symbol: "BTC", name: "Bitcoin" }, [
      { namer: "coingecko", localName: "issued:bitcoin" },
    ]);
    const synced = await evmAccount("S2", "0xs2");
    await dbFor(USER).snapshots.write(synced.id, {
      takenAt: now - DAY,
      totalUsd: 100,
      balances: [{ amount: 1, usdValue: 100, kind: "spot", platform: "evm:1", tokenId: btc }],
    });
    const m = await dbFor(USER).accounts.create({
      connectorId: "manual",
      label: "M9",
      creds: JSON.stringify({ tokens: "[]" }),
    });
    await addManualActivities(USER, m.id, [
      { token: localBtc, kind: "add", amount: 2, occurredAt: now - 128 * HOUR, price: 63921 },
    ]);

    const { of } = await rowsByLabel(true);
    // 同步账户那条有真基准(正好 24h)→ 算得出;manual 那条走账本 → 也算得出。互不影响。
    expect(of("S2")?.balances[0]?.gain24h).not.toBeNull();
    expect(of("M9")?.balances[0]?.gain24h).not.toBeNull();
  });
});
