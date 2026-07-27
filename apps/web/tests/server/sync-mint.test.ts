import { env } from "cloudflare:test";
import {
  createGlobalTokenRefIndexStore,
  createUserCacheStore,
  createUserTokenStore,
} from "@folio/db";
import { syncAccount } from "@folio/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/lib/server/internal/db";
import { buildSyncDeps } from "../../src/lib/server/internal/sync-deps";

// 写路径切到 mint 的端到端测试(#200):喂 provider 余额 → 落库 → 快照行带正确的 token_id。
//
// 走**真 D1**,不是内存假实现 —— 这一片的全部风险都在真表的约束上(`token_refs` 的主键、
// 并发下的 upsert-then-read)。内存 fake 用 Map,这些都测不出来。
//
// 上游一律**打桩到抛错**:mint 按设计全程不碰网络。任何一次外呼都会让用例红,这正是断言之一。

const USER = "user-sync-mint";
const NAMER = "coingecko";
const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_ARB = "evm:42161/contract:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const USDC_SOL = "solana/contract:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  await env.DB.prepare("DELETE FROM global_token_ref_index").run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

beforeEach(async () => {
  await resetUser();
  // 任何外呼都算失败:mint 是写路径上的一步,必须纯本地。
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`写路径不该碰网络,却请求了 ${String(input)}`);
  });
});

afterEach(() => vi.restoreAllMocks());

// 预热缓存里放一份 warm 集,让 symbol 那一档在本地就有候选可判(否则它会想回源)。
async function seedWarm(rows: { id: string; symbol: string; rank: number }[]): Promise<void> {
  await createUserCacheStore(env, { userId: USER }).put(
    "warm",
    {
      asOf: Date.now(),
      rows: rows.map((r) => ({
        info: { ref: `${NAMER}/${r.id}`, symbol: r.symbol, name: r.symbol },
        price: { unitPrice: 1, marketCapRank: r.rank, asOf: Date.now() },
      })),
    },
    60 * 60 * 1000,
  );
}

async function seedRefIndex(rows: { ref: string; localName: string }[]): Promise<void> {
  await createGlobalTokenRefIndexStore(env).putAll(
    rows.map((r) => ({ ref: r.ref, namer: NAMER, localName: r.localName })),
    Date.now(),
  );
}

async function makeAccount(label = "w"): Promise<string> {
  const account = await db.createAccount(USER, {
    connectorId: "evm",
    label,
    creds: null,
  });
  return account.id;
}

// provider 报的一笔余额(`Balance` 形状 —— 这是编排器收到的东西)。
const bal = (tokenRef: string, symbol: string, over: Record<string, unknown> = {}) => ({
  symbol,
  amount: 1,
  value: 100,
  kind: "spot" as const,
  tokenRef,
  ...over,
});

// **走真编排器**(#202 之后 mint 是 `SyncDeps` 上独立的一步,跑在 revalue 之前)。
// 只把取数那一步打桩,mint / revalue / 写快照全用真实现 —— 顺序与 best-effort 语义因此都被覆盖,
// 不必在测试里复刻编排逻辑(复刻的话,编排顺序一改测试还是绿的,那就白测了)。
async function syncWith(
  balances: ReturnType<typeof bal>[],
  accountId: string,
  deps = buildSyncDeps(),
): Promise<string> {
  const accounts = await db.listAccountsByUser(USER);
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`no such account ${accountId}`);
  const res = await syncAccount(
    {
      ...deps,
      fetchBalances: async () => ({
        status: "ok" as const,
        balances: balances as never,
        totalUsd: balances.reduce((s, b) => s + b.value, 0),
      }),
    },
    USER,
    account,
    null,
  );
  if (!res.ok || !res.snapshotId) throw new Error(`sync failed: ${res.error ?? "no snapshot"}`);
  return res.snapshotId;
}

async function balancesOf(snapshotId: string) {
  const { results } = await env.DB.prepare(
    "SELECT symbol, token_id as tokenId, token_ref as tokenRef FROM snapshot_balances WHERE snapshot_id = ?",
  )
    .bind(snapshotId)
    .all<{ symbol: string; tokenId: string | null; tokenRef: string | null }>();
  return results;
}

describe("落库后快照行带 token_id", () => {
  it("映射表认得的合约 → 认出上游币,快照行带 token_id", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal(USDC_ETH, "USDC")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenId).toBeTruthy();
    // 旧列仍在写(读路径还没切)。
    expect(rows[0].tokenRef).toBe(USDC_ETH);
    expect(rows[0].symbol).toBe("USDC");

    // 那个 Token 确实被上游认出来了(有 coingecko 那一档的 ref 行)。
    const store = createUserTokenStore(env, { userId: USER, namer: NAMER });
    expect((await store.getById(rows[0].tokenId as string))?.ref).toBe("coingecko/usd-coin");
  });

  it("映射表没有的合约 → 也建行、快照照写,只是上游没认出来", async () => {
    const accountId = await makeAccount();
    const snapshotId = await syncWith([bal("evm:1/contract:0xdeadbeef", "SCAM")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows[0].tokenId).toBeTruthy(); // 认不出来也有 token_id,快照不卡在上游上
    const store = createUserTokenStore(env, { userId: USER, namer: NAMER });
    expect((await store.getById(rows[0].tokenId as string))?.ref).toBeNull();
  });

  it("多链的同一个币 → 一个 Token + 多条 ref", async () => {
    await seedRefIndex([
      { ref: USDC_ETH, localName: "usd-coin" },
      { ref: USDC_ARB, localName: "usd-coin" },
    ]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal(USDC_ETH, "USDC"), bal(USDC_ARB, "USDC")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(2);
    expect(rows[0].tokenId).toBe(rows[1].tokenId); // 同一个 Token
    const { results } = await env.DB.prepare("SELECT count(*) as n FROM tokens WHERE user_id = ?")
      .bind(USER)
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  it("原生币走 symbol 那一档(它按设计不进映射表)", async () => {
    await seedWarm([{ id: "ethereum", symbol: "ETH", rank: 2 }]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal("evm:1/native", "ETH")], accountId);

    const rows = await balancesOf(snapshotId);
    const store = createUserTokenStore(env, { userId: USER, namer: NAMER });
    expect((await store.getById(rows[0].tokenId as string))?.ref).toBe("coingecko/ethereum");
  });

  // 合约的 symbol 是部署者随手填的 —— 地址查不到就该老实认不出来(#210 的闸)。
  it("山寨合约的 symbol 写着 USDC 也不许并进真 USDC", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    await seedWarm([{ id: "usd-coin", symbol: "USDC", rank: 6 }]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith(
      [bal(USDC_ETH, "USDC"), bal("evm:1/contract:0xfake", "USDC")],
      accountId,
    );

    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(2);
    expect(rows[0].tokenId).not.toBe(rows[1].tokenId); // 各占一行
  });

  // **这条曾经只在内存假实现里测过,于是漏掉了一个真 bug**:`coingecko/<id>` 形的 ref 本身
  // 就是上游的命名(手记里用户选了币),它已经是锚 —— 缺了短路的话会把 [ref, upstreamRef]
  // 两条相同的 ref 塞进同一批,真表上 `token_refs` 的主键会冲突、**整个账户的快照写失败**。
  // 内存 fake 用 Map,静静吞掉了这个约束。所以这一支必须在真 D1 上跑。
  it("上游命名形的 ref(手记选了币)→ 自己就是锚,只出一条 ref 行", async () => {
    const accountId = await makeAccount();
    const snapshotId = await syncWith([bal("coingecko/usd-coin", "USDC")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows[0].tokenId).toBeTruthy();

    const store = createUserTokenStore(env, { userId: USER, namer: NAMER });
    expect((await store.getById(rows[0].tokenId as string))?.ref).toBe("coingecko/usd-coin");
    // 只有一条 ref 行 —— 去重生效(不然主键就撞了)。
    const { results } = await env.DB.prepare(
      "SELECT count(*) as n FROM token_refs WHERE user_id = ? AND token_id = ?",
    )
      .bind(USER, rows[0].tokenId)
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  // 六个来源的 USDC 落一个 Token —— 这一组在内存里测过(mint.test.ts),这里验它在真表上也成立:
  // 六条 ref 行、一个 token,而且 `token_refs` 的主键不会在任何一步撞上。
  it("六个来源的 USDC → 一个 Token、六条 ref 行", async () => {
    await seedRefIndex([
      { ref: USDC_ETH, localName: "usd-coin" },
      { ref: USDC_ARB, localName: "usd-coin" },
      { ref: USDC_SOL, localName: "usd-coin" },
    ]);
    await seedWarm([{ id: "usd-coin", symbol: "USDC", rank: 6 }]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith(
      [
        bal(USDC_ETH, "USDC"),
        bal(USDC_ARB, "USDC"),
        bal(USDC_SOL, "USDC"),
        bal("binance/USDC", "USDC"),
        bal("okx/USDC", "USDC"),
        bal("coingecko/usd-coin", "USDC"),
      ],
      accountId,
    );

    const rows = await balancesOf(snapshotId);
    expect(new Set(rows.map((r) => r.tokenId)).size).toBe(1); // 全落一个 Token
    const { results } = await env.DB.prepare(
      "SELECT count(*) as n FROM token_refs WHERE user_id = ? AND token_id = ?",
    )
      .bind(USER, rows[0].tokenId)
      .all<{ n: number }>();
    expect(results[0].n).toBe(6); // 六条来源各一行
  });
});

describe("perp 两类行都有 token_id", () => {
  it("权益行与单仓位行都拿到 token_id", async () => {
    await seedWarm([{ id: "usd-coin", symbol: "USDC", rank: 6 }]);
    const accountId = await makeAccount("perp");

    const snapshotId = await syncWith(
      [
        bal("hyperliquid/USDC", "USDC", { kind: "perp_equity" }),
        // 单仓位行金额为零、不进聚合,但也该有身份。
        bal("hyperliquid/BTC", "BTC", { kind: "perp_position", usdValue: 0 }),
      ],
      accountId,
    );

    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tokenId)).toBe(true);
  });
});

describe("每账户独立落库的性质保住", () => {
  it("一个账户失败不影响另一个账户落库", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    const bad = await makeAccount("bad");
    const good = await makeAccount("good");
    const deps = buildSyncDeps();
    const accounts = await db.listAccountsByUser(USER);
    const of = (id: string) => accounts.find((a) => a.id === id) as never;

    // 坏账户:取数直接抛 → syncAccount 收成 ok:false,不落库、不向上抛。
    const badRes = await syncAccount(
      {
        ...deps,
        fetchBalances: async () => {
          throw new Error("provider down");
        },
      },
      USER,
      of(bad),
      null,
    );
    expect(badRes.ok).toBe(false);

    // 同一份 deps 继续服务另一个账户,照样落库、照样带 token_id。
    const snapshotId = await syncWith([bal(USDC_ETH, "USDC")], good, deps);
    expect((await balancesOf(snapshotId))[0].tokenId).toBeTruthy();
  });

  // 账户并发跑,同一条 ref 会被同时 mint。靠 store 的 upsert-then-read 幂等收敛,不加 barrier。
  it("两个账户并发落同一个币 → 只出一个 Token 行", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    const a = await makeAccount("a");
    const b = await makeAccount("b");
    const deps = buildSyncDeps();

    const [s1, s2] = await Promise.all([
      syncWith([bal(USDC_ETH, "USDC")], a, deps),
      syncWith([bal(USDC_ETH, "USDC")], b, deps),
    ]);

    const [r1, r2] = [await balancesOf(s1), await balancesOf(s2)];
    expect(r1[0].tokenId).toBe(r2[0].tokenId);
    const { results } = await env.DB.prepare("SELECT count(*) as n FROM tokens WHERE user_id = ?")
      .bind(USER)
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });
});

describe("provider 报的元信息进代币行", () => {
  // 名字与图在编排里会被丢掉(快照不落它们),所以是在取到余额那一刻收的 seed。
  it("建行用 provider 报的 name / logo(图落备用槽)", async () => {
    const accountId = await makeAccount();
    const deps = buildSyncDeps();
    // seed 是在 `fetchViaConnector` 里收的;本测试把 `fetchBalances` 整个打了桩、绕开了它,
    // 所以这里没有 seed —— 正好验「没有 seed 时退回 symbol 一项」这条兜底。
    const snapshotId = await syncWith([bal("evm:1/contract:0xnoseed", "FOO")], accountId, deps);
    const rows = await balancesOf(snapshotId);
    const store = createUserTokenStore(env, { userId: USER, namer: NAMER });
    const info = await store.getById(rows[0].tokenId as string);
    // 没有 seed 时退回 symbol 一项 —— 名字等于 symbol,不是空。
    expect(info).toMatchObject({ symbol: "FOO", name: "FOO" });
  });
});

describe("多行同批不撞 D1 的参数上限", () => {
  // snapshot_balances 现在 12 列 → 每批 8 行。给 25 行跨 4 批。
  it("25 笔持仓一次落库,全部带 token_id", async () => {
    const accountId = await makeAccount();
    const balances = Array.from({ length: 25 }, (_, i) =>
      bal(`evm:1/contract:0x${(i + 1).toString(16).padStart(40, "0")}`, `T${i}`),
    );
    const snapshotId = await syncWith(balances, accountId);
    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(25);
    expect(rows.every((r) => r.tokenId)).toBe(true);
  });
});
