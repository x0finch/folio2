import { env } from "cloudflare:test";
import type { CgkCoinId, TokenInfo, TokenPrice, TokenRef } from "@folio/tokens";
import { beforeEach, describe, expect, it } from "vitest";
import { createTokenStore } from "../src"; // 全局代币缓存:公开独立导出(非 createDb 门面)
import { getDb } from "../src/client";
import { tokenIndex, tokenMeta, tokens } from "../src/schema";

const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as CgkCoinId });
const info = (ref: TokenRef, symbol: string, logo?: string): TokenInfo => ({
  ref,
  symbol,
  name: symbol.toUpperCase(),
  logo,
});
const price = (ref: TokenRef, unitPrice: number, rank?: number): TokenPrice => ({
  ref,
  unitPrice,
  marketCapRank: rank,
  asOf: 111,
});

// pool 不隔离每测试存储 → 每测试前清空 token 表(索引 FK → 先删索引)。
beforeEach(async () => {
  const db = getDb(env);
  await db.batch([db.delete(tokenIndex), db.delete(tokens), db.delete(tokenMeta)]);
});

const TTL = 10_000;
const TTLS = { indexTtlMs: TTL, infoTtlMs: TTL, priceTtlMs: TTL };

describe("warm + candidates + listTopTokens", () => {
  it("putWarm upserts tokens + symbol index; getCandidates returns all per symbol", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.putWarm(
      [
        { info: info(cg("usd-coin"), "USDC"), price: price(cg("usd-coin"), 1, 6) },
        { info: info(cg("usdc-x"), "USDC"), price: price(cg("usdc-x"), 0.9, 9000) },
        { info: info(cg("ethereum"), "ETH"), price: price(cg("ethereum"), 3500, 2) },
      ],
      TTL,
      TTL,
    );
    const cands = await store.getCandidates("USDC");
    expect(cands).toContainEqual({ ref: cg("usd-coin"), marketCapRank: 6 });
    expect(cands).toContainEqual({ ref: cg("usdc-x"), marketCapRank: 9000 });
    expect(cands).toHaveLength(2);
    expect(await store.getCandidates("ETH")).toEqual([{ ref: cg("ethereum"), marketCapRank: 2 }]);
    expect(await store.warmAsOf()).toBe(1000);
  });

  it("warm respects TTL (expired symbol index → no candidates)", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.putWarm(
      [{ info: info(cg("ethereum"), "ETH"), price: price(cg("ethereum"), 3500, 2) }],
      TTL,
      TTL,
    );
    clock = 1000 + TTL + 1; // 过期
    expect(await store.getCandidates("ETH")).toEqual([]);
  });

  it("re-warm keeps a stable token id (upsert, not duplicate)", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.putWarm(
      [{ info: info(cg("ethereum"), "ETH"), price: price(cg("ethereum"), 1, 2) }],
      TTL,
      TTL,
    );
    await store.putWarm(
      [{ info: info(cg("ethereum"), "ETH"), price: price(cg("ethereum"), 2, 2) }],
      TTL,
      TTL,
    );
    const rows = await getDb(env).select().from(tokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unitPrice).toBe(2);
  });

  it("listTopTokens orders by rank asc (unranked last), honors limit, includes name/logo", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.putWarm(
      [
        { info: info(cg("ethereum"), "eth", "Lo-eth"), price: price(cg("ethereum"), 3500, 2) },
        { info: info(cg("bitcoin"), "btc", "Lo-btc"), price: price(cg("bitcoin"), 65000, 1) },
        { info: info(cg("some-fork"), "sbf", "Lo-sbf"), price: price(cg("some-fork"), 0.1) },
      ],
      TTL,
      TTL,
    );
    const top = await store.listTopTokens(2);
    expect(top.map((t) => t.ref.identifier)).toEqual(["bitcoin", "ethereum"]);
    expect(top[0]).toMatchObject({ symbol: "btc", name: "BTC", logo: "Lo-btc" });
    const all = await store.listTopTokens(10);
    expect(all.map((t) => t.ref.identifier)).toEqual(["bitcoin", "ethereum", "some-fork"]);
  });
});

describe("impl index (tokenKey): ensure / getByTokenKey / markCgkChecked", () => {
  const KEY = "eip155:1/erc20:0xabc";

  it("ensureTokenKey seeds an orphan (source=provider) with provider data", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.ensureTokenKey(KEY, { symbol: "FOO", name: "Foo Token", providerLogo: "L" }, TTL);
    const rec = (await store.getByTokenKey([KEY])).get(KEY);
    expect(rec).toMatchObject({
      ref: null, // 孤儿:CGK 未收录
      symbol: "FOO",
      name: "Foo Token",
      providerLogo: "L",
      cgkCheckedUntil: null,
    });
  });

  it("ensureTokenKey on existing orphan refreshes provider data + extends expiry", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.ensureTokenKey(KEY, { symbol: "FOO" }, TTL);
    clock = 1000 + TTL - 1; // 未过期时再 seed(模拟下一次 sync)
    await store.ensureTokenKey(KEY, { symbol: "FOO", name: "Foo", providerLogo: "L2" }, TTL);
    clock = 1000 + TTL + 1; // 原 TTL 已过,但 expiry 被顺延
    const rec = (await store.getByTokenKey([KEY])).get(KEY);
    expect(rec).toMatchObject({ name: "Foo", providerLogo: "L2" });
  });

  it("markCgkChecked records recheck horizon on the index row", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.ensureTokenKey(KEY, { symbol: "FOO" }, TTL);
    await store.markCgkChecked(KEY, 5000);
    expect((await store.getByTokenKey([KEY])).get(KEY)?.cgkCheckedUntil).toBe(5000);
  });

  it("expired index row → miss", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.ensureTokenKey(KEY, { symbol: "FOO" }, TTL);
    clock = 1000 + TTL + 1;
    expect((await store.getByTokenKey([KEY])).size).toBe(0);
  });

  it("ensureTokenKey on a cgk-pointed key only refreshes the fallback logo slot", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.linkTokenKeyToCgk(
      KEY,
      info(cg("foo"), "FOO", "cgk-logo"),
      price(cg("foo"), 1),
      TTLS,
    );
    await store.ensureTokenKey(KEY, { symbol: "foo2", providerLogo: "prov" }, TTL);
    const rec = (await store.getByTokenKey([KEY])).get(KEY);
    expect(rec).toMatchObject({
      ref: cg("foo"),
      symbol: "FOO", // cgk 行的 symbol/name 不被 provider seed 覆盖
      logo: "cgk-logo",
      providerLogo: "prov", // 备用槽被刷新
    });
  });
});

describe("linkTokenKeyToCgk (升级合并)", () => {
  const KEY = "eip155:1/erc20:0xabc";

  it("orphan → cgk: creates cgk row, carries provider_logo, repoints, deletes orphan", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.ensureTokenKey(KEY, { symbol: "FOO", providerLogo: "prov" }, TTL);
    await store.linkTokenKeyToCgk(
      KEY,
      info(cg("foo"), "FOO", "cgk-logo"),
      price(cg("foo"), 2),
      TTLS,
    );
    const rec = (await store.getByTokenKey([KEY])).get(KEY);
    expect(rec).toMatchObject({
      ref: cg("foo"),
      logo: "cgk-logo",
      providerLogo: "prov", // 孤儿的备用图被拷带
      price: { unitPrice: 2, stale: false },
    });
    // 孤儿行已删(全表只剩 cgk 行)
    const rows = await getDb(env).select().from(tokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("coingecko");
  });

  it("orphan → existing cgk row (from warm): merges into it, keeps its provider_logo if set", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.putWarm(
      [{ info: info(cg("foo"), "FOO"), price: price(cg("foo"), 5, 7) }],
      TTL,
      TTL,
    );
    await store.ensureTokenKey(KEY, { symbol: "FOO", providerLogo: "prov" }, TTL);
    await store.linkTokenKeyToCgk(KEY, info(cg("foo"), "FOO", "cgk-logo"), undefined, TTLS);
    const rec = (await store.getByTokenKey([KEY])).get(KEY);
    expect(rec).toMatchObject({ ref: cg("foo"), logo: "cgk-logo", providerLogo: "prov" });
    // price 未传 → 保留 warm 写入的价
    expect(rec?.price?.unitPrice).toBe(5);
    expect(await getDb(env).select().from(tokens)).toHaveLength(1);
  });

  it("no prior row: creates cgk row + index directly", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.linkTokenKeyToCgk(KEY, info(cg("foo"), "FOO"), price(cg("foo"), 3), TTLS);
    expect((await store.getByTokenKey([KEY])).get(KEY)).toMatchObject({ ref: cg("foo") });
  });
});

describe("getByRefs + putPrices(SWR:过期=stale 不删)", () => {
  it("returns record with fresh price; stale after expiry (still returned)", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.putWarm(
      [{ info: info(cg("bitcoin"), "BTC", "L"), price: price(cg("bitcoin"), 65000, 1) }],
      TTL,
      TTL * 10, // info 更长
    );
    let rec = (await store.getByRefs([cg("bitcoin")])).get("coingecko:bitcoin");
    expect(rec?.price).toMatchObject({ unitPrice: 65000, stale: false });

    clock = 1000 + TTL + 1; // 价过期、info 未过期
    rec = (await store.getByRefs([cg("bitcoin")])).get("coingecko:bitcoin");
    expect(rec).toBeDefined(); // 行仍可见(info 在)
    expect(rec?.price).toMatchObject({ unitPrice: 65000, stale: true }); // 旧价带 stale

    // putPrices 刷新后回到 fresh
    await store.putPrices([price(cg("bitcoin"), 66000, 1)], TTL);
    rec = (await store.getByRefs([cg("bitcoin")])).get("coingecko:bitcoin");
    expect(rec?.price).toMatchObject({ unitPrice: 66000, stale: false });
  });

  it("info expiry hides the record entirely; miss not in map", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.putWarm(
      [{ info: info(cg("bitcoin"), "BTC"), price: price(cg("bitcoin"), 1, 1) }],
      TTL,
      TTL,
    );
    clock = 1000 + TTL + 1;
    const map = await store.getByRefs([cg("bitcoin"), cg("nope")]);
    expect(map.size).toBe(0);
  });
});

describe("source bucketing (no userId — partitioned by source)", () => {
  it("a store bound to another source sees nothing", async () => {
    const cgStore = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await cgStore.putWarm(
      [{ info: info(cg("ethereum"), "eth"), price: price(cg("ethereum"), 3500, 2) }],
      TTL,
      TTL,
    );
    // 模拟未来另一数据源(类型上目前仅 coingecko,测试里 cast)
    const other = createTokenStore(env, {
      source: "cmc" as TokenRef["source"],
      now: () => 1000,
    });
    expect(await other.getCandidates("eth")).toEqual([]);
    expect(await other.listTopTokens(5)).toEqual([]);
    expect((await other.getByRefs([cg("ethereum")])).size).toBe(0);
  });
});
