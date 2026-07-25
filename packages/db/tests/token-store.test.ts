import { env } from "cloudflare:test";
import { cgkRef, type TokenInfo, type TokenPrice, type TokenRef } from "@folio/oracle-basic";
import { beforeEach, describe, expect, it } from "vitest";
import { createTokenStore } from "../src"; // 全局代币缓存:公开独立导出(非 createDb 门面)
import { getDb } from "../src/client";
import { tokenIndex, tokenMeta, tokens, tokenVendorIds } from "../src/schema";

const cg = cgkRef;
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

// pool 不隔离每测试存储 → 每测试前清空 token 表(FK 顺序:索引 → tokens)。
beforeEach(async () => {
  const db = getDb(env);
  await db.batch([
    db.delete(tokenIndex),
    db.delete(tokenVendorIds),
    db.delete(tokens),
    db.delete(tokenMeta),
  ]);
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
    expect(top.map((t) => t.ref)).toEqual([cg("bitcoin"), cg("ethereum")]);
    expect(top[0]).toMatchObject({ symbol: "btc", name: "BTC", logo: "Lo-btc" });
    const all = await store.listTopTokens(10);
    expect(all.map((t) => t.ref)).toEqual([cg("bitcoin"), cg("ethereum"), cg("some-fork")]);
  });
});

describe("impl index (tokenRef): ensure / getByTokenRef / markCgkChecked", () => {
  const KEY = "eip155:1/erc20:0xabc";

  it("ensureTokenRef seeds an orphan (source=provider) with provider data", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.ensureTokenRef(KEY, { symbol: "FOO", name: "Foo Token", providerLogo: "L" }, TTL);
    const rec = (await store.getByTokenRef([KEY])).get(KEY);
    expect(rec).toMatchObject({
      ref: null, // 孤儿:CGK 未收录
      symbol: "FOO",
      name: "Foo Token",
      providerLogo: "L",
      cgkCheckedUntil: null,
    });
  });

  it("ensureTokenRef on existing orphan refreshes provider data + extends expiry", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.ensureTokenRef(KEY, { symbol: "FOO" }, TTL);
    clock = 1000 + TTL - 1; // 未过期时再 seed(模拟下一次 sync)
    await store.ensureTokenRef(KEY, { symbol: "FOO", name: "Foo", providerLogo: "L2" }, TTL);
    clock = 1000 + TTL + 1; // 原 TTL 已过,但 expiry 被顺延
    const rec = (await store.getByTokenRef([KEY])).get(KEY);
    expect(rec).toMatchObject({ name: "Foo", providerLogo: "L2" });
  });

  it("markCgkChecked records recheck horizon on the index row", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.ensureTokenRef(KEY, { symbol: "FOO" }, TTL);
    await store.markCgkChecked(KEY, 5000);
    expect((await store.getByTokenRef([KEY])).get(KEY)?.cgkCheckedUntil).toBe(5000);
  });

  it("expired index row → miss", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.ensureTokenRef(KEY, { symbol: "FOO" }, TTL);
    clock = 1000 + TTL + 1;
    expect((await store.getByTokenRef([KEY])).size).toBe(0);
  });

  it("ensureTokenRef on a cgk-pointed key only refreshes the fallback logo slot", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.linkTokenRefToCgk(
      KEY,
      info(cg("foo"), "FOO", "cgk-logo"),
      price(cg("foo"), 1),
      TTLS,
    );
    await store.ensureTokenRef(KEY, { symbol: "foo2", providerLogo: "prov" }, TTL);
    const rec = (await store.getByTokenRef([KEY])).get(KEY);
    expect(rec).toMatchObject({
      ref: cg("foo"),
      symbol: "FOO", // cgk 行的 symbol/name 不被 provider seed 覆盖
      logo: "cgk-logo",
      providerLogo: "prov", // 备用槽被刷新
    });
  });
});

describe("linkTokenRefToCgk (升级合并)", () => {
  const KEY = "eip155:1/erc20:0xabc";

  it("orphan → cgk: creates cgk row, carries provider_logo, repoints, deletes orphan", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.ensureTokenRef(KEY, { symbol: "FOO", providerLogo: "prov" }, TTL);
    await store.linkTokenRefToCgk(
      KEY,
      info(cg("foo"), "FOO", "cgk-logo"),
      price(cg("foo"), 2),
      TTLS,
    );
    const rec = (await store.getByTokenRef([KEY])).get(KEY);
    expect(rec).toMatchObject({
      ref: cg("foo"),
      logo: "cgk-logo",
      providerLogo: "prov", // 孤儿的备用图被拷带
      price: { unitPrice: 2, stale: false },
    });
    // 孤儿行已删(全表只剩 cgk 行);该行有一条 coingecko vendor 映射指向它
    const rows = await getDb(env).select().from(tokens);
    expect(rows).toHaveLength(1);
    const maps = await getDb(env).select().from(tokenVendorIds);
    expect(maps).toEqual([{ tokenId: rows[0]!.id, vendor: "coingecko", vendorId: "foo" }]);
  });

  it("orphan → existing cgk row (from warm): merges into it, keeps its provider_logo if set", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.putWarm(
      [{ info: info(cg("foo"), "FOO"), price: price(cg("foo"), 5, 7) }],
      TTL,
      TTL,
    );
    await store.ensureTokenRef(KEY, { symbol: "FOO", providerLogo: "prov" }, TTL);
    await store.linkTokenRefToCgk(KEY, info(cg("foo"), "FOO", "cgk-logo"), undefined, TTLS);
    const rec = (await store.getByTokenRef([KEY])).get(KEY);
    expect(rec).toMatchObject({ ref: cg("foo"), logo: "cgk-logo", providerLogo: "prov" });
    // price 未传 → 保留 warm 写入的价
    expect(rec?.price?.unitPrice).toBe(5);
    expect(await getDb(env).select().from(tokens)).toHaveLength(1);
  });

  it("no prior row: creates cgk row + index directly", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.linkTokenRefToCgk(KEY, info(cg("foo"), "FOO"), price(cg("foo"), 3), TTLS);
    expect((await store.getByTokenRef([KEY])).get(KEY)).toMatchObject({ ref: cg("foo") });
  });

  it("跨链同币:两条不同 tokenRef → 同一 cgk coin → 归并进同一个内部 id(#46 关键缝)", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    const K1 = "eip155:1/erc20:0xa0b"; // USDC @ Ethereum
    const K2 = "eip155:42161/erc20:0xaf8"; // USDC @ Arbitrum
    await store.linkTokenRefToCgk(K1, info(cg("usd-coin"), "USDC"), price(cg("usd-coin"), 1), TTLS);
    await store.linkTokenRefToCgk(K2, info(cg("usd-coin"), "USDC"), price(cg("usd-coin"), 1), TTLS);
    // 两条 tokenRef 都解析到同一条 tokens 行(同一内部 id)—— 不因链不同而碎裂。
    const recs = await store.getByTokenRef([K1, K2]);
    expect(recs.get(K1)!.id).toBe(recs.get(K2)!.id);
    // 全表只一条 tokens 行 + 一条 coingecko vendor 映射。
    expect(await getDb(env).select().from(tokens)).toHaveLength(1);
    expect(await getDb(env).select().from(tokenVendorIds)).toHaveLength(1);
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
    let rec = (await store.getByRefs([cg("bitcoin")])).get(cg("bitcoin"));
    expect(rec?.price).toMatchObject({ unitPrice: 65000, stale: false });

    clock = 1000 + TTL + 1; // 价过期、info 未过期
    rec = (await store.getByRefs([cg("bitcoin")])).get(cg("bitcoin"));
    expect(rec).toBeDefined(); // 行仍可见(info 在)
    expect(rec?.price).toMatchObject({ unitPrice: 65000, stale: true }); // 旧价带 stale

    // putPrices 刷新后回到 fresh
    await store.putPrices([price(cg("bitcoin"), 66000, 1)], TTL);
    rec = (await store.getByRefs([cg("bitcoin")])).get(cg("bitcoin"));
    expect(rec?.price).toMatchObject({ unitPrice: 66000, stale: false });
  });

  it("刷价不抹排名:putPrices 收到无 rank 的价(simple/price)时,保留 warm 写入的既有排名", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    // warm 给排名(top-N markets 带 rank)
    await store.putWarm(
      [{ info: info(cg("bitcoin"), "BTC", "L"), price: price(cg("bitcoin"), 65000, 1) }],
      TTL,
      TTL * 10,
    );
    expect((await store.getByRefs([cg("bitcoin")])).get(cg("bitcoin"))?.marketCapRank).toBe(1);

    // 过期后走 SWR 刷价:simple/price 不含排名(rank 省略),不应把排名清成 null
    clock = 1000 + TTL + 1;
    await store.putPrices([price(cg("bitcoin"), 66000)], TTL);
    const rec = (await store.getByRefs([cg("bitcoin")])).get(cg("bitcoin"));
    expect(rec?.price).toMatchObject({ unitPrice: 66000, stale: false });
    expect(rec?.marketCapRank).toBe(1); // 排名保留,未被刷价抹掉
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

describe("getById (logo 代理端点:按内部行 id 读整行,source 无关)", () => {
  it("按 id 读出整行(cgk 图与孤儿 providerLogo 都能拿);未知 id → undefined", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.putWarm(
      [{ info: info(cg("bitcoin"), "BTC", "cgk-L"), price: price(cg("bitcoin"), 65000, 1) }],
      TTL,
      TTL,
    );
    // 孤儿(无 vendor 映射)也能按 id 命中(getById 走主键、不过滤)。
    await store.ensureTokenRef(
      "eip155:1/erc20:0xorphan",
      { symbol: "ORP", name: "Orphan", providerLogo: "prov-L" },
      TTL,
    );
    // btc = cgk 行(经 coingecko vendor 映射找);orphan = 无映射(经 tokenRef 索引找)。
    const maps = await getDb(env).select().from(tokenVendorIds);
    const btcId = maps.find((m) => m.vendorId === "bitcoin")!.tokenId;
    const idxRows = await getDb(env).select().from(tokenIndex);
    const orphanId = idxRows.find(
      (r) => r.kind === "tokenRef" && r.key === "eip155:1/erc20:0xorphan",
    )!.tokenId;

    expect((await store.getById(btcId))?.logo).toBe("cgk-L");
    expect((await store.getById(orphanId))?.providerLogo).toBe("prov-L");
    expect(await store.getById("no-such-id")).toBeUndefined();
  });

  it("info 过期仍按 id 返回(logo 端点按主键服务;与渲染路径 getByTokenRef 一致,不门控 info)", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.putWarm(
      [{ info: info(cg("bitcoin"), "BTC", "cgk-L"), price: price(cg("bitcoin"), 65000, 1) }],
      TTL,
      TTL, // infoTtl
    );
    const btcId = (await getDb(env).select().from(tokens))[0]!.id;
    clock = 1000 + TTL + 1; // info 过期
    expect((await store.getById(btcId))?.logo).toBe("cgk-L"); // 仍返回,不 404
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
    // 模拟未来另一数据源(命名者换个字符串即可 —— 溶解成串后无需 cast)
    const other = createTokenStore(env, {
      source: "cmc",
      now: () => 1000,
    });
    expect(await other.getCandidates("eth")).toEqual([]);
    expect(await other.listTopTokens(5)).toEqual([]);
    expect((await other.getByRefs([cg("ethereum")])).size).toBe(0);
  });
});

describe("展示分组已退场(ADR 0021):桥接变体各自独立成行", () => {
  it("tether 与 usdt0 是两个 Token,不再被任何组串起来", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.putWarm(
      [
        { info: info(cg("tether"), "USDT"), price: price(cg("tether"), 1, 3) },
        { info: info(cg("usdt0"), "USDT"), price: price(cg("usdt0"), 1, 300) }, // 桥接变体
      ],
      TTL,
      TTL,
    );
    const recs = await store.getByRefs([cg("tether"), cg("usdt0")]);
    const tetherId = recs.get(cg("tether"))?.id;
    const usdt0Id = recs.get(cg("usdt0"))?.id;
    expect(tetherId).toBeDefined();
    expect(usdt0Id).toBeDefined();
    expect(tetherId).not.toBe(usdt0Id); // 同 symbol、同组过 —— 现在只按 tokens.id 论身份
    expect(await getDb(env).select().from(tokens)).toHaveLength(2);
  });
});
