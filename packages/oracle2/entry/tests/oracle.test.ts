import { describe, expect, it } from "vitest";
import { createOracleFor, createOracleWarm, type OracleConfig } from "../src";
import {
  fakeCacheStore,
  fakeRefIndexStore,
  fakeTokenPriceStore,
  fakeTokenStore,
  fakeUpstream,
} from "./fakes";

// 记下每个工厂被调了几次、拿到的是哪个 userId —— 惰性与绑定都靠它验。
function countingConfig() {
  const calls: string[] = [];
  const tokenStores = new Map<string, ReturnType<typeof fakeTokenStore>>();
  const priceStores = new Map<string, ReturnType<typeof fakeTokenPriceStore>>();
  const caches = new Map<string, ReturnType<typeof fakeCacheStore>>();
  const refIndex = fakeRefIndexStore();
  const upstream = fakeUpstream();

  const memo = <T>(m: Map<string, T>, userId: string, make: () => T): T => {
    const cur = m.get(userId) ?? make();
    m.set(userId, cur);
    return cur;
  };

  const cfg: OracleConfig = {
    createTokenStore(userId) {
      calls.push(`tokenStore:${userId}`);
      return memo(tokenStores, userId, fakeTokenStore);
    },
    createTokenPriceStore(userId) {
      calls.push(`priceStore:${userId}`);
      return memo(priceStores, userId, fakeTokenPriceStore);
    },
    createCacheStore(userId) {
      calls.push(`cache:${userId}`);
      return memo(caches, userId, fakeCacheStore);
    },
    createRefIndexStore() {
      calls.push("refIndex");
      return refIndex;
    },
    createUpstream() {
      calls.push("upstream");
      return upstream;
    },
  };
  return { cfg, calls, tokenStores };
}

describe("oracleFor —— 显式工厂", () => {
  it("每个用户拿到自己的 store,userId 由工厂吃掉、不进任何服务签名", async () => {
    const { cfg, tokenStores } = countingConfig();
    const oracleFor = createOracleFor(cfg);

    const alice = oracleFor("u_alice");
    const bob = oracleFor("u_bob");
    expect(await alice.tokens.enrich(["tk_1"])).toEqual(new Map());

    tokenStores.get("u_alice")?.rows.set("tk_1", {
      id: "tk_1",
      ref: "src/bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
      infoStale: false,
    });

    expect((await alice.tokens.enrich(["tk_1"])).get("tk_1")?.symbol).toBe("BTC");
    expect(await bob.tokens.enrich(["tk_1"])).toEqual(new Map()); // bob 的库里没有
  });
});

describe("惰性", () => {
  it("建门面本身零构造;只碰 tokens → 不建全局映射 store", () => {
    const { cfg, calls } = countingConfig();
    const oracle = createOracleFor(cfg)("u1");
    expect(calls).toEqual([]);

    void oracle.tokens;
    expect(calls).toEqual(["tokenStore:u1", "priceStore:u1", "cache:u1", "upstream"]);
    expect(calls).not.toContain("refIndex");
  });

  it("同一个子服务反复访问只建一次(建后记忆)", () => {
    const { cfg, calls } = countingConfig();
    const oracle = createOracleFor(cfg)("u1");
    void oracle.tokens;
    const first = calls.length;
    void oracle.tokens;
    void oracle.tokens;
    expect(calls).toHaveLength(first);
  });
});

describe("契约往返(内存假实现)", () => {
  it("代币表:建行 → 挂 ref → 按 id 读回;并发建同一条 ref 幂等", async () => {
    const store = fakeTokenStore();
    const id = await store.create({ symbol: "USDC", name: "USD Coin" }, ["evm:1/contract:0xa0b8"]);

    expect(await store.findByRefs(["evm:1/contract:0xa0b8"])).toEqual(
      new Map([["evm:1/contract:0xa0b8", { tokenId: id, linked: false }]]),
    );
    expect(await store.getById(id)).toMatchObject({ symbol: "USDC", ref: null });

    const [a, b] = await Promise.all([
      store.create({ symbol: "X" }, ["evm:1/contract:0xdead"]),
      store.create({ symbol: "X" }, ["evm:1/contract:0xdead"]),
    ]);
    expect(a).toBe(b);
  });

  it("价 store:写 → 读回;过期不删,读出带 stale", async () => {
    const prices = fakeTokenPriceStore();
    await prices.put([{ tokenId: "tk_1", unitPrice: 60000, asOf: prices.now }], 1000);
    expect((await prices.getByIds(["tk_1"])).get("tk_1")).toMatchObject({
      unitPrice: 60000,
      stale: false,
    });

    prices.now += 2000;
    expect((await prices.getByIds(["tk_1"])).get("tk_1")).toMatchObject({ stale: true });
  });

  it("全局映射:按 (namer, ref) 点查;miss 的键不出现", async () => {
    const store = fakeRefIndexStore();
    expect(await store.refreshedAt("src")).toBeNull();

    await store.putAll(
      [{ ref: "evm:1/contract:0xa0b8", namer: "src", localName: "usd-coin" }],
      123,
    );
    expect(await store.refreshedAt("src")).toBe(123);
    expect(await store.lookup("src", ["evm:1/contract:0xa0b8", "evm:1/contract:0xdead"])).toEqual(
      new Map([["evm:1/contract:0xa0b8", "usd-coin"]]),
    );
    // 换个命名者就查不到 —— 这正是「加源只加行」的另一面。
    expect(await store.lookup("other", ["evm:1/contract:0xa0b8"])).toEqual(new Map());
  });
});

describe("全局维护任务不挂 per-user 门面", () => {
  it("createOracleWarm 不需要 userId:拉 → 一次整份灌 → 记得刷新时刻", async () => {
    const refIndex = fakeRefIndexStore();
    const upstream = fakeUpstream();
    upstream.refIndex = {
      rows: [
        { ref: "evm:1/contract:0xa0b8", namer: "src", localName: "usd-coin" },
        { ref: "solana/contract:EPjF", namer: "src", localName: "usd-coin" },
      ],
      unmatchedPlatforms: [],
      skipped: 7,
    };
    const warm = createOracleWarm({
      createRefIndexStore: () => refIndex,
      createUpstream: () => upstream,
    });

    expect(await warm.refIndexRefreshedAt()).toBeNull();
    const summary = await warm.warmRefIndex(1_700_000_000_000);

    expect(summary).toEqual({ rows: 2, unmatchedPlatforms: [], skipped: 7 });
    expect(refIndex.writes).toBe(1); // 一次整份写
    expect(await warm.refIndexRefreshedAt()).toBe(1_700_000_000_000);
  });

  it("失配经 onWarn 报出;没有失配就不吵", async () => {
    const warns: { message: string; meta: Record<string, unknown> }[] = [];
    const upstream = fakeUpstream();
    upstream.refIndex = { rows: [], unmatchedPlatforms: ["sui"], skipped: 0 };
    const warm = createOracleWarm({
      createRefIndexStore: () => fakeRefIndexStore(),
      createUpstream: () => upstream,
      onWarn: (message, meta) => warns.push({ message, meta }),
    });

    await warm.warmRefIndex(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.meta).toEqual({ namer: "src", platforms: ["sui"] });

    upstream.refIndex = { rows: [], unmatchedPlatforms: [], skipped: 0 };
    await warm.warmRefIndex(2);
    expect(warns).toHaveLength(1);
  });
});
