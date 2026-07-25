import { describe, expect, it } from "vitest";
import { createOracleFor, type OracleStores } from "../src";
import { fakeCacheStore, fakeCgkRefStore, fakeSource, fakeTokenStore } from "./fakes";

// 记下每个 store 工厂被调了几次、拿到的是哪个 userId —— 惰性与绑定都靠它验。
function countingStores() {
  const calls: string[] = [];
  const tokenStores = new Map<string, ReturnType<typeof fakeTokenStore>>();
  const cacheStores = new Map<string, ReturnType<typeof fakeCacheStore>>();
  const cgk = fakeCgkRefStore();
  const stores: OracleStores = {
    tokens(userId) {
      calls.push(`tokens:${userId}`);
      const s = tokenStores.get(userId) ?? fakeTokenStore();
      tokenStores.set(userId, s);
      return s;
    },
    cache(userId) {
      calls.push(`cache:${userId}`);
      const s = cacheStores.get(userId) ?? fakeCacheStore();
      cacheStores.set(userId, s);
      return s;
    },
    cgkRefs() {
      calls.push("cgkRefs");
      return cgk;
    },
  };
  return { stores, calls, tokenStores };
}

describe("oracleFor —— 显式工厂", () => {
  it("每个用户拿到自己的 store,userId 由工厂吃掉、不进任何服务签名", async () => {
    const { stores, tokenStores } = countingStores();
    const oracleFor = createOracleFor({ stores, source: fakeSource() });

    const alice = oracleFor("u_alice");
    const bob = oracleFor("u_bob");
    tokenStores.get("u_alice"); // 尚未触碰 → 还没造
    expect(await alice.tokens.byIds(["tk_1"])).toEqual(new Map());

    // alice 的库里有一行,bob 的没有 —— 两人各一套 store。
    const aliceStore = tokenStores.get("u_alice");
    expect(aliceStore).toBeDefined();
    aliceStore?.rows.set("tk_1", { id: "tk_1", symbol: "BTC", name: "Bitcoin" });

    expect((await alice.tokens.byIds(["tk_1"])).get("tk_1")?.symbol).toBe("BTC");
    expect(await bob.tokens.byIds(["tk_1"])).toEqual(new Map());
  });
});

describe("惰性", () => {
  it("只碰 tokens → 另两个子服务的 store 不被构造", () => {
    const { stores, calls } = countingStores();
    const oracle = createOracleFor({ stores, source: fakeSource() })("u1");
    expect(calls).toEqual([]); // 建门面本身零构造

    void oracle.tokens;
    expect(calls).toEqual(["tokens:u1", "cache:u1"]); // cgkRefs 没被碰
  });

  it("只碰 cgkRefs → 代币表与缓存不被构造", () => {
    const { stores, calls } = countingStores();
    const oracle = createOracleFor({ stores, source: fakeSource() })("u1");

    void oracle.cgkRefs;
    expect(calls).toEqual(["cgkRefs"]);
  });

  it("同一个子服务反复访问只建一次(建后记忆)", () => {
    const { stores, calls } = countingStores();
    const oracle = createOracleFor({ stores, source: fakeSource() })("u1");

    void oracle.tokens;
    void oracle.tokens;
    void oracle.tokens;
    expect(calls).toEqual(["tokens:u1", "cache:u1"]);
  });
});

describe("契约往返(内存假实现)", () => {
  it("代币表:建行 → 挂 ref → 按 id 读回", async () => {
    const store = fakeTokenStore();
    const id = await store.create({ symbol: "USDC", name: "USD Coin" }, ["evm:1/0xa0b8"]);

    expect(await store.findByRefs(["evm:1/0xa0b8"])).toEqual(
      new Map([["evm:1/0xa0b8", { tokenId: id, linked: false }]]),
    );
    expect((await store.getByIds([id])).get(id)).toMatchObject({ symbol: "USDC" });
    expect(await store.getById(id)).toMatchObject({ name: "USD Coin" });
    expect(await store.getById("nope")).toBeUndefined();
  });

  it("代币表:并发建同一条 ref 幂等 —— 后到的拿到先到的那个 id", async () => {
    const store = fakeTokenStore();
    const [a, b] = await Promise.all([
      store.create({ symbol: "USDC" }, ["evm:1/0xa0b8"]),
      store.create({ symbol: "USDC" }, ["evm:1/0xa0b8"]),
    ]);
    expect(a).toBe(b);
    expect(store.rows.size).toBe(1);
  });

  it("cgk_refs:整份写 → 正查;miss 的键不出现", async () => {
    const store = fakeCgkRefStore();
    expect(await store.refreshedAt()).toBeNull();

    await store.putAll([{ ref: "evm:1/0xa0b8", coinId: "usd-coin" }], 123);
    expect(await store.refreshedAt()).toBe(123);
    expect(await store.lookup(["evm:1/0xa0b8", "evm:1/0xdead"])).toEqual(
      new Map([["evm:1/0xa0b8", "usd-coin"]]),
    );
  });

  it("cache:写 → 读回;过期不删,读出带 stale", async () => {
    const cache = fakeCacheStore();
    await cache.put("fx:EUR", { usdPerUnit: 1.08 }, 1000);
    expect(await cache.get("fx:EUR")).toEqual({ value: { usdPerUnit: 1.08 }, stale: false });

    cache.now += 2000;
    expect(await cache.get("fx:EUR")).toEqual({ value: { usdPerUnit: 1.08 }, stale: true });
    expect(await cache.get("fx:JPY")).toBeUndefined();
  });
});
