import { env } from "cloudflare:test";
import type { TokenInfo } from "@folio/oracle-basic";
import { eq, inArray } from "drizzle-orm";
import { Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import {
  accounts,
  globalTokenRefIndex,
  snapshotBalances,
  snapshots,
  tokenDailyPrices,
  tokenRefs,
  tokens,
} from "../src/schema";
import { user } from "../src/schema/auth";
import { forDomain, forOracle, NOW } from "./effect";

// Why real tables: the oracle pieces use in-memory fakes where `Map` refs silently overwrite duplicates in a batch, while on the real table the `token_refs` PK conflicts and the whole batch fails. These rerun mint's shapes against the constraints.

const USER_A = "u-a";
const USER_B = "u-b";
const NAMER = "coingecko"; // the upstream's self-reported id; the store only uses it to tell "recognised or not"
const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_ARB = "evm:42161/contract:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const USDC_UP = "coingecko/issued:usd-coin";

async function resetUser(userId: string): Promise<void> {
  const db = getDb(env);
  await db.delete(user).where(eq(user.id, userId));
  await db.insert(user).values({
    id: userId,
    name: userId,
    email: `${userId}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  const db = getDb(env);
  // Deleting the user cascades tokens / token_refs / user_cache; the two global tables have no userId and are cleared separately.
  await resetUser(USER_A);
  await resetUser(USER_B);
  await db.batch([db.delete(globalTokenRefIndex), db.delete(tokenDailyPrices)]);
});

// The store comes through the ticket (production path); the handle just lets cases `await store.xxx(...)`. The clock is fixed at `NOW`; cases needing "long after" pass the last argument.
const tokensOf = forOracle((db) => db.tokens);
const pricesOf = forOracle((db) => db.tokenPrices);
const cacheOf = forDomain((db) => db.cache);

const storeFor = (userId: string, namer = NAMER, nowMs = NOW) => tokensOf(userId, namer, nowMs);
const priceStoreFor = (userId: string, namer = NAMER, nowMs = NOW) =>
  pricesOf(userId, namer, nowMs);
const cacheFor = (userId: string, nowMs = NOW) => cacheOf(userId, nowMs);

// `getById` returns `Option` ("no such row" is a branch callers must take); cases care about the row, so the wrapper is stripped, giving undefined when absent.
const getInfo = async (
  store: { getById: (id: string) => Promise<Option.Option<TokenInfo>> },
  id: string,
) => Option.getOrUndefined(await store.getById(id));

const seed = (symbol: string, name?: string, providerLogo?: string) => ({
  symbol,
  name,
  providerLogo,
});

describe("create row and idempotency", () => {
  it("creates a row and links a ref; found by ref, readable by id", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC", "USD Coin", "p.png"), [USDC_ETH, USDC_UP]);

    const hits = await store.findByRefs([USDC_ETH, USDC_UP]);
    expect(hits.get(USDC_ETH)).toEqual({ tokenId: id, linked: true });
    expect(hits.get(USDC_UP)).toEqual({ tokenId: id, linked: true });

    const info = await getInfo(store, id);
    expect(info).toMatchObject({ id, symbol: "USDC", name: "USD Coin", providerLogo: "p.png" });
    // ref = the current upstream's name for it (exists only with an upstream-level ref row).
    expect(info?.ref).toBe(USDC_UP);
  });

  it("getAll / price getAll (whole-table): item by item equal to reading by id, only the caller's", async () => {
    const store = storeFor(USER_A);
    const usdc = await store.create(seed("USDC", "USD Coin", "p.png"), [USDC_ETH, USDC_UP]);
    const loose = await store.create(seed("FOO"), [USDC_ARB]);
    await storeFor(USER_B).create(seed("USDC"), [USDC_UP]);
    await priceStoreFor(USER_A).put([{ tokenId: usdc, unitPrice: 1, asOf: 900 }], 500);

    expect(await store.getAll()).toEqual(await store.getByIds([usdc, loose]));
    expect([...(await store.getAll()).keys()].sort()).toEqual([usdc, loose].sort());
    const prices = priceStoreFor(USER_A);
    expect(await prices.getAll()).toEqual(await prices.getByIds([usdc, loose]));
    expect([...(await prices.getAll()).keys()]).toEqual([usdc]); // ones with no price yet don't appear
  });

  it("only the provider's ref: not yet recognised upstream, ref is null and linked is false", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("SCAM"), [USDC_ETH]);
    expect((await getInfo(store, id))?.ref).toBeNull();
    expect((await store.findByRefs([USDC_ETH])).get(USDC_ETH)).toEqual({
      tokenId: id,
      linked: false,
    });
  });

  // Accounts run concurrently so one ref can be minted at once; a fake Map always passes, the real table relies on PK + upsert-then-read.
  it("creating the same ref concurrently: one row, both calls return the same id", async () => {
    const store = storeFor(USER_A);
    const [a, b] = await Promise.all([
      store.create(seed("USDC"), [USDC_ETH, USDC_UP]),
      store.create(seed("USDC"), [USDC_ETH, USDC_UP]),
    ]);
    expect(a).toBe(b);
    const rows = await getDb(env).select().from(tokens).where(eq(tokens.userId, USER_A));
    expect(rows).toHaveLength(1); // the loser deleted the orphan row it created
  });

  // The real-table version of a past bug: before mint deduped, a batch could carry two identical refs.
  it("two identical refs in one batch: no PK conflict, still one row", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_UP, USDC_UP]);
    expect((await store.findByRefs([USDC_UP])).get(USDC_UP)?.tokenId).toBe(id);
  });

  it("an unparseable ref stays out of the table: the row is created, just without a ref row", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("FOO"), ["nonsense"]);
    expect((await store.findByRefs(["nonsense"])).size).toBe(0);
    expect((await getInfo(store, id))?.symbol).toBe("FOO");
  });
});

describe("isolated per user", () => {
  it("two users each hold USDC: one row each with their own ref row, invisible to each other", async () => {
    const a = storeFor(USER_A);
    const b = storeFor(USER_B);
    const idA = await a.create(seed("USDC"), [USDC_ETH, USDC_UP]);
    const idB = await b.create(seed("USDC"), [USDC_ETH, USDC_UP]);

    expect(idA).not.toBe(idB);
    expect((await a.findByRefs([USDC_UP])).get(USDC_UP)?.tokenId).toBe(idA);
    expect((await b.findByRefs([USDC_UP])).get(USDC_UP)?.tokenId).toBe(idB);
    // Reading another user's id returns nothing.
    expect(await getInfo(a, idB)).toBeUndefined();
  });
});

describe("multi-chain merge", () => {
  it("a coin's second-chain ref adds one row and creates no new Token", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_ETH, USDC_UP]);
    expect(await store.linkRef(id, USDC_ARB)).toBe(id);

    const hits = await store.findByRefs([USDC_ETH, USDC_ARB, USDC_UP]);
    expect(new Set([...hits.values()].map((h) => h.tokenId))).toEqual(new Set([id]));
    const rows = await getDb(env).select().from(tokens).where(eq(tokens.userId, USER_A));
    expect(rows).toHaveLength(1);
  });

  it("linkRef is idempotent: a ref that already has an owner returns that owner without re-pointing", async () => {
    const store = storeFor(USER_A);
    const mine = await store.create(seed("USDC"), [USDC_ETH]);
    const other = await store.create(seed("ETH"), ["evm:1/native"]);
    expect(await store.linkRef(other, USDC_ETH)).toBe(mine);
  });

  // One Token has at most one ref per namer (one upstream coin). The app-level linkRef checks first, then the unique index (user_id, token_id, namer) backstops it (next case).
  it("a Token that already has an upstream-level ref can't take a second", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_ETH, USDC_UP]);
    await store.linkRef(id, "coingecko/issued:tether"); // try to attach a second upstream coin to the same row
    expect((await getInfo(store, id))?.ref).toBe(USDC_UP); // still the original
    expect((await store.findByRefs(["coingecko/issued:tether"])).size).toBe(0);
  });

  // The app-level read-then-write isn't atomic across Workers instances; the unique index is the real race guard. Bypass the store and insert two rows with the same (user_id, token_id, namer) and different local_name to verify the constraint exists.
  it("the unique index blocks two refs for one Token under one namer: a direct second insert errors", async () => {
    const db = getDb(env);
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_UP]); // coingecko/issued:usd-coin
    await expect(
      db.insert(tokenRefs).values({
        userId: USER_A,
        namer: "coingecko",
        localName: "issued:tether", // same Token, same namer, different coin: hits the unique index
        tokenId: id,
      }),
    ).rejects.toThrow();
  });
});

describe("merge", () => {
  it("re-points refs and historical snapshot token_id, and deletes the old row", async () => {
    const db = getDb(env);
    const store = storeFor(USER_A);
    const orphan = await store.create(seed("USDC", undefined, "p.png"), [USDC_ETH]);
    const owner = await store.create(seed("USDC", "USD Coin"), [USDC_UP]);

    // Build a historical snapshot balance pointing at the old row.
    await db.insert(accounts).values({
      id: "acc-1",
      userId: USER_A,
      connectorId: "evm" as never,
      label: "w",
      createdAt: 1,
    });
    await db
      .insert(snapshots)
      .values({ id: "snap-1", accountId: "acc-1", takenAt: 1, totalUsd: 1 });
    await db.insert(snapshotBalances).values({
      id: "bal-1",
      snapshotId: "snap-1",
      amount: 1,
      usdValue: 1,
      kind: "spot",
      tokenId: orphan,
    });

    await store.merge(orphan, owner);

    expect((await store.findByRefs([USDC_ETH])).get(USDC_ETH)?.tokenId).toBe(owner);
    expect(await getInfo(store, orphan)).toBeUndefined();
    const bal = await db
      .select({ tokenId: snapshotBalances.tokenId })
      .from(snapshotBalances)
      .where(eq(snapshotBalances.id, "bal-1"));
    expect(bal[0].tokenId).toBe(owner); // identity changes, amounts don't
    // The old row's provider logo is a display fallback; it mustn't be lost with the row.
    expect((await getInfo(store, owner))?.providerLogo).toBe("p.png");
  });

  it("both sides having the same ref: no PK conflict (the old row's is deleted first)", async () => {
    const store = storeFor(USER_A);
    const a = await store.create(seed("USDC"), [USDC_ETH]);
    const b = await store.create(seed("USDC"), [USDC_ARB]);
    await store.linkRef(b, USDC_UP);
    // Making both rows have the evm:1 ref directly? linkRef returns the existing owner, so build them independently then merge.
    await store.merge(a, b);
    expect((await store.findByRefs([USDC_ETH, USDC_ARB])).size).toBe(2);
    expect(await getInfo(store, a)).toBeUndefined();
  });

  // Each side has a ref under the same namer for a different coin: re-pointing would give into two under one namer and hit the unique index. Merge dedupes per namer, keeps into's, and converges to one upstream coin without throwing.
  it("each side with a different-coin ref under the same namer: into's is kept, no unique-index conflict", async () => {
    const store = storeFor(USER_A);
    const from = await store.create(seed("BTC"), ["coingecko/issued:bitcoin"]);
    const into = await store.create(seed("BTC"), ["coingecko/issued:wrapped-bitcoin"]);

    await store.merge(from, into);

    expect(await getInfo(store, from)).toBeUndefined();
    // into keeps its own; from's coingecko/bitcoin is dropped, not merged in.
    expect((await getInfo(store, into))?.ref).toBe("coingecko/issued:wrapped-bitcoin");
    expect((await store.findByRefs(["coingecko/issued:bitcoin"])).size).toBe(0);
    const refs = await getDb(env)
      .select({ tokenId: tokenRefs.tokenId })
      .from(tokenRefs)
      .where(eq(tokenRefs.tokenId, into));
    expect(refs).toHaveLength(1); // one ref per Token under coingecko
  });

  // Defensive: merge takes token ids (UUIDs) the caller should own; if another user's id arrives, snapshot-balance re-pointing and providerLogo backfill must still be scoped by userId. The adversarial fixture sits at the layer it would touch: B's token row plus B's historical balance pointing at it.
  it("merging with another user's token id leaves their snapshot balances and token rows untouched", async () => {
    const db = getDb(env);
    const a = storeFor(USER_A);
    const b = storeFor(USER_B);
    const fromB = await b.create(seed("USDC", undefined, "b.png"), [USDC_ETH]);
    const intoB = await b.create(seed("USDC", "USD Coin"), [USDC_UP]);
    const intoA = await a.create(seed("USDC", "USD Coin"), [USDC_UP]);
    const fromA = await a.create(seed("USDC", undefined, "a.png"), [USDC_ARB]);
    await db.insert(accounts).values({
      id: "acc-b",
      userId: USER_B,
      connectorId: "evm" as never,
      label: "w",
      createdAt: 1,
    });
    await db
      .insert(snapshots)
      .values({ id: "snap-b", accountId: "acc-b", takenAt: 1, totalUsd: 1 });
    await db.insert(snapshotBalances).values({
      id: "bal-b",
      snapshotId: "snap-b",
      amount: 1,
      usdValue: 1,
      kind: "spot",
      tokenId: fromB,
    });
    const tokenRowsOf = (ids: string[]) =>
      db.select().from(tokens).where(inArray(tokens.id, ids)).orderBy(tokens.id);
    const balB = () =>
      db
        .select({ tokenId: snapshotBalances.tokenId })
        .from(snapshotBalances)
        .where(eq(snapshotBalances.id, "bal-b"));
    const before = await tokenRowsOf([fromB, intoB]);

    // (1) both ids are B's; (2) from is B's and into is A's own; (3) from is A's and into is B's.
    await a.merge(fromB, intoB);
    await a.merge(fromB, intoA);
    await a.merge(fromA, intoB);

    expect(await tokenRowsOf([fromB, intoB])).toEqual(before);
    expect(await balB()).toEqual([{ tokenId: fromB }]);
    // B's provider logo must not be copied into A's row.
    expect((await getInfo(a, intoA))?.providerLogo).toBeUndefined();
  });

  // Daily prices are keyed globally by tokenRef, independent of token_id, so a merge mustn't leave a gap in the curve.
  it("a merge doesn't affect the history curve: the winner reads the same daily prices as before", async () => {
    const store = storeFor(USER_A);
    const prices = priceStoreFor(USER_A);
    const orphan = await store.create(seed("USDC"), [USDC_ETH]);
    const owner = await store.create(seed("USDC"), [USDC_UP]);
    await prices.putDaily(owner, [{ dayBucket: 20180, unitPrice: 1 }]);

    const before = await prices.getDaily(owner, [20180]);
    await store.merge(orphan, owner);
    expect(await prices.getDaily(owner, [20180])).toEqual(before);
  });
});

describe("fillInfo fills only empty slots", () => {
  it("fields with values stay, empty ones are filled", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC", "Provider Name", "p.png"), [USDC_ETH]);
    await store.fillInfo(id, { name: "Upstream Name", logo: "u.png", providerLogo: "other.png" });
    const info = await getInfo(store, id);
    expect(info?.name).toBe("Provider Name"); // already set: not overwritten
    expect(info?.providerLogo).toBe("p.png"); // already set: not overwritten
    expect(info?.logo).toBe("u.png"); // was empty: filled
  });
});

// `putInfo` is the opposite of `fillInfo`: upstream wins. An on-chain symbol is whatever the deployer wrote (MATIC to POL), and not overwriting would show one coin under two names.
describe("putInfo overwrites the three upstream fields", () => {
  it("symbol/name/logo are always overwritten; the connector's fallback image is untouched", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("MATIC", "Matic Network", "zerion.png"), [USDC_ETH]);

    await store.putInfo(
      [{ tokenId: id, symbol: "POL", name: "POL (ex-MATIC)", logo: "pol.png" }],
      60_000,
    );

    const info = await getInfo(store, id);
    expect(info).toMatchObject({
      symbol: "POL",
      name: "POL (ex-MATIC)",
      logo: "pol.png",
      providerLogo: "zerion.png", // upstream may not overwrite the fallback slot
    });
  });

  it("when upstream gave no image this time: keeps the existing one, doesn't null it", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("OLD"), [USDC_ETH]);
    await store.putInfo([{ tokenId: id, symbol: "OLD", name: "Old", logo: "keep.png" }], 60_000);
    await store.putInfo([{ tokenId: id, symbol: "NEW", name: "New" }], 60_000);
    expect(await getInfo(store, id)).toMatchObject({ symbol: "NEW", logo: "keep.png" });
  });

  it("info TTL: stale on create; fresh once refreshed; stale again after expiry, but **expired rows are still returned**", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_ETH]);
    // On create info_expires_at = now, so already expired: the row came from the connector and upstream hasn't overwritten it.
    expect((await getInfo(store, id))?.infoStale).toBe(true);

    await store.putInfo([{ tokenId: id, symbol: "USDC", name: "USD Coin" }], 60_000);
    expect((await getInfo(store, id))?.infoStale).toBe(false);

    // After the clock passes the TTL (now is injected as 1000; use another store instance to see the same row).
    const later = storeFor(USER_A, NAMER, 100_000);
    const info = await getInfo(later, id);
    expect(info?.infoStale).toBe(true);
    expect(info?.name).toBe("USD Coin"); // still returned: a gated read would 404 the logo proxy endpoint
  });

  it("called with another user's tokenId: no row changes (userId is in the where)", async () => {
    const mine = await storeFor(USER_A).create(seed("USDC"), [USDC_ETH]);
    await storeFor(USER_B).putInfo([{ tokenId: mine, symbol: "HACKED", name: "Hacked" }], 60_000);
    expect((await getInfo(storeFor(USER_A), mine))?.symbol).toBe("USDC");
  });

  it("an empty array issues no statement", async () => {
    await expect(storeFor(USER_A).putInfo([], 60_000)).resolves.toBeUndefined();
  });
});

// Upstream and exchanges rename at different times, so the moment they converge is evidence the name changed; an identity-changing write also marks info stale, or display names lag up to INFO_TTL_MS (30d).
describe("identity changes mark info stale", () => {
  const freshen = async (store: ReturnType<typeof storeFor>, id: string) => {
    await store.putInfo([{ tokenId: id, symbol: "MATIC", name: "Matic Network" }], 60_000);
    expect((await getInfo(store, id))?.infoStale).toBe(false);
  };

  it("linkRef really adding a ref marks it stale", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("MATIC"), [USDC_ETH]);
    await freshen(store, id);

    await store.linkRef(id, USDC_ARB);
    expect((await getInfo(store, id))?.infoStale).toBe(true);
  });

  it("both early-exit paths of linkRef write nothing: not marked stale", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("MATIC"), [USDC_ETH]);
    await store.linkRef(id, USDC_UP); // take the primary-source slot first
    await freshen(store, id);

    await store.linkRef(id, USDC_ETH); // this ref already has an owner: early exit
    expect((await getInfo(store, id))?.infoStale).toBe(false);
    await store.linkRef(id, "coingecko/issued:other-coin"); // the namer already has a different name: no second ref
    expect((await getInfo(store, id))?.infoStale).toBe(false);
  });

  it("after a merge the winner is marked stale: it kept its own (possibly old) name", async () => {
    const store = storeFor(USER_A);
    const winner = await store.create(seed("MATIC", "Matic Network"), [USDC_ETH]);
    const loser = await store.create(seed("POL"), [USDC_ARB]);
    await freshen(store, winner);

    await store.merge(loser, winner);
    const info = await getInfo(store, winner);
    expect(info?.symbol).toBe("MATIC"); // the winner's name wasn't changed by the loser
    expect(info?.infoStale).toBe(true); // but it is marked stale
  });
});

describe("price facet", () => {
  it("write then read back; expiry doesn't delete, reads come back stale", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_UP]);
    const prices = priceStoreFor(USER_A);

    await prices.put([{ tokenId: id, unitPrice: 1, change24h: 0.1, asOf: 900 }], 500);
    const fresh = (await prices.getByIds([id])).get(id);
    expect(fresh).toMatchObject({ unitPrice: 1, change24h: 0.1, asOf: 900, stale: false });

    // Clock moves forward: the same row reads stale, the value remains.
    const later = priceStoreFor(USER_A, NAMER, 9999);
    expect((await later.getByIds([id])).get(id)).toMatchObject({ unitPrice: 1, stale: true });
  });

  it("a row with no price yet doesn't appear in the results", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_UP]);
    const prices = priceStoreFor(USER_A);
    expect((await prices.getByIds([id])).size).toBe(0);
  });

  // The price-refresh endpoint carries no rank; `?? null` would repeatedly wipe holdings' ranks.
  it("a price refresh doesn't wipe the existing market-cap rank", async () => {
    const db = getDb(env);
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_UP]);
    await db.update(tokens).set({ marketCapRank: 7 }).where(eq(tokens.id, id));
    const prices = priceStoreFor(USER_A);
    await prices.put([{ tokenId: id, unitPrice: 1, asOf: 1 }], 500);
    expect((await prices.getByIds([id])).get(id)?.marketCapRank).toBe(7);
  });

  // A batch is one `UPDATE ... FROM json_each(?)`. These pin what the old per-row UPDATE gave naturally and the single statement must deliberately keep.
  it("a batch of several rows: each written on its own; ranked ones set, missing change24h written as NULL; other users' rows untouched", async () => {
    const a = storeFor(USER_A);
    const x = await a.create(seed("AAA"), ["coingecko/issued:aaa"]);
    const y = await a.create(seed("BBB"), ["coingecko/issued:bbb"]);
    const other = await storeFor(USER_B).create(seed("AAA"), ["coingecko/issued:aaa"]);
    const prices = priceStoreFor(USER_A);
    await prices.put([{ tokenId: x, unitPrice: 2, change24h: 0.5, asOf: 800 }], 500);
    await priceStoreFor(USER_B).put([{ tokenId: other, unitPrice: 9, asOf: 800 }], 500);

    await prices.put(
      [
        { tokenId: x, unitPrice: 3.25, asOf: 900 },
        { tokenId: y, unitPrice: 0.000123, change24h: -1.5, marketCapRank: 42, asOf: 901 },
        // Not the caller's id: even sandwiched in the batch it must not write to B's row.
        { tokenId: other, unitPrice: 1234, asOf: 902 },
      ],
      500,
    );

    const got = await prices.getByIds([x, y]);
    expect(got.get(x)).toEqual({ unitPrice: 3.25, asOf: 900, stale: false });
    expect(got.get(y)).toEqual({
      unitPrice: 0.000123,
      change24h: -1.5,
      marketCapRank: 42,
      asOf: 901,
      stale: false,
    });
    expect((await priceStoreFor(USER_B).getByIds([other])).get(other)?.unitPrice).toBe(9);
  });

  it("the same id twice in a batch: the later one wins", async () => {
    const id = await storeFor(USER_A).create(seed("USDC"), [USDC_UP]);
    const prices = priceStoreFor(USER_A);
    await prices.put(
      [
        { tokenId: id, unitPrice: 1, asOf: 900 },
        { tokenId: id, unitPrice: 2, asOf: 901 },
      ],
      500,
    );
    expect((await prices.getByIds([id])).get(id)).toMatchObject({ unitPrice: 2, asOf: 901 });
  });
});

describe("historical daily prices keyed globally by tokenRef", () => {
  it("two users' same coin share one set of rows: whoever writes first, the other reads it directly", async () => {
    const a = storeFor(USER_A);
    const b = storeFor(USER_B);
    const idA = await a.create(seed("BTC"), ["coingecko/issued:bitcoin"]);
    const idB = await b.create(seed("BTC"), ["coingecko/issued:bitcoin"]);
    expect(idA).not.toBe(idB);

    const pricesA = priceStoreFor(USER_A);
    const pricesB = priceStoreFor(USER_B);
    await pricesA.putDaily(idA, [{ dayBucket: 20180, unitPrice: 42000 }]);

    // B wrote nothing yet can read it: that is the whole point of global keying.
    expect(await pricesB.getDaily(idB, [20180])).toEqual(new Map([[20180, 42000]]));
    // The table really has one row.
    const rows = await getDb(env).select().from(tokenDailyPrices);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenRef).toBe("coingecko/issued:bitcoin");
  });

  it("a coin upstream hasn't recognised has no global key: reads empty, writes skip, no throw", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("SCAM"), [USDC_ETH]); // only the provider's ref
    const prices = priceStoreFor(USER_A);
    await prices.putDaily(id, [{ dayBucket: 20180, unitPrice: 1 }]);
    expect((await prices.getDaily(id, [20180])).size).toBe(0);
    expect(await getDb(env).select().from(tokenDailyPrices)).toHaveLength(0);
  });

  it("writing the same (ref, day) again overwrites, not a duplicate row", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("BTC"), ["coingecko/issued:bitcoin"]);
    const prices = priceStoreFor(USER_A);
    await prices.putDaily(id, [{ dayBucket: 20180, unitPrice: 1 }]);
    await prices.putDaily(id, [{ dayBucket: 20180, unitPrice: 2 }]);
    expect(await prices.getDaily(id, [20180])).toEqual(new Map([[20180, 2]]));
  });

  // Direct read/write by ref (fiat history rates): no tokenId-to-ref translation, so any ref can be stored; fiat refs (`fiat/issued:CODE`) have no token_refs row, so `putDaily` skips them and only this path can store them.
  it("getDailyByRef/putDailyByRef: stores and reads any ref directly, no token_refs row needed", async () => {
    const prices = priceStoreFor(USER_A);
    await prices.putDailyByRef("fiat/issued:EUR", [
      { dayBucket: 20180, unitPrice: 1.08 },
      { dayBucket: 20181, unitPrice: 1.09 },
    ]);
    expect(await prices.getDailyByRef("fiat/issued:EUR", [20180, 20181])).toEqual(
      new Map([
        [20180, 1.08],
        [20181, 1.09],
      ]),
    );
    // Global key, independent of user: another user reads the same ref directly.
    const other = priceStoreFor(USER_B);
    expect(await other.getDailyByRef("fiat/issued:EUR", [20180])).toEqual(new Map([[20180, 1.08]]));
    // A (ref, day) collision overwrites.
    await prices.putDailyByRef("fiat/issued:EUR", [{ dayBucket: 20180, unitPrice: 1.1 }]);
    expect(await prices.getDailyByRef("fiat/issued:EUR", [20180])).toEqual(new Map([[20180, 1.1]]));
  });
});

describe("per-user cache", () => {
  it("write then read back; expiry doesn't delete, reads come back stale; isolated per user", async () => {
    const a = cacheFor(USER_A, 1000);
    const b = cacheFor(USER_B, 1000);
    await a.put("fx:EUR", 1.08, 500);

    expect(await a.get("fx:EUR")).toEqual(Option.some({ value: 1.08, stale: false }));
    expect(await b.get("fx:EUR")).toEqual(Option.none()); // another user's cache is invisible

    const later = cacheFor(USER_A, 9999);
    expect(await later.get("fx:EUR")).toEqual(Option.some({ value: 1.08, stale: true }));
  });

  it("writing the same key again overwrites", async () => {
    const a = cacheFor(USER_A, 1000);
    await a.put("warm", [{ ref: "coingecko/issued:bitcoin" }], 500);
    await a.put("warm", [{ ref: "coingecko/issued:ethereum" }], 500);
    expect(Option.getOrThrow(await a.get("warm"))).toMatchObject({
      value: [{ ref: "coingecko/issued:ethereum" }],
    });
  });

  it("an absent key gives undefined", async () => {
    const a = cacheFor(USER_A);
    expect(await a.get("platform:evm:1")).toEqual(Option.none());
  });

  it("batch read: one IN fetches several keys, misses don't appear; isolated per user", async () => {
    const a = cacheFor(USER_A, 1000);
    const b = cacheFor(USER_B, 1000);
    await a.putMany([
      { key: "platform:evm:1", value: { name: "Ethereum" }, ttlMs: 500 },
      { key: "platform:solana", value: { name: "Solana" }, ttlMs: 500 },
    ]);

    const hits = await a.getMany(["platform:evm:1", "platform:solana", "platform:nope"]);
    expect([...hits.keys()].sort()).toEqual(["platform:evm:1", "platform:solana"]);
    expect(hits.get("platform:evm:1")?.value).toEqual({ name: "Ethereum" });
    expect(await b.getMany(["platform:evm:1"])).toEqual(new Map()); // another user's is invisible
  });

  it("batch write: **each key carries its own TTL** (platform hits long, negatives short rely on this)", async () => {
    const a = cacheFor(USER_A, 1000);
    await a.putMany([
      { key: "platform:evm:1", value: { name: "Ethereum" }, ttlMs: 5000 },
      { key: "platform:nochain", value: { name: null }, ttlMs: 100 },
    ]);

    // now=2000: the long-TTL one is still fresh, the short-TTL one is stale; expiry doesn't delete, so it still reads.
    const later = cacheFor(USER_A, 2000);
    const hits = await later.getMany(["platform:evm:1", "platform:nochain"]);
    expect(hits.get("platform:evm:1")?.stale).toBe(false);
    expect(hits.get("platform:nochain")).toEqual({ value: { name: null }, stale: true });
  });

  it("a batch write overwrites; an empty batch is a no-op (doesn't blow up)", async () => {
    const a = cacheFor(USER_A, 1000);
    await a.putMany([{ key: "fx:EUR", value: 1.08, ttlMs: 500 }]);
    await a.putMany([{ key: "fx:EUR", value: 1.09, ttlMs: 500 }]);
    expect(await a.get("fx:EUR")).toEqual(Option.some({ value: 1.09, stale: false }));

    await expect(a.putMany([])).resolves.toBeUndefined();
    expect(await a.getMany([])).toEqual(new Map());
  });

  it("batch read beyond the chunk size still returns everything (D1 bound-parameter cap leads to chunked IN)", async () => {
    const a = cacheFor(USER_A, 1000);
    const keys = Array.from({ length: 200 }, (_, i) => `platform:evm:${i}`);
    await a.putMany(keys.map((key, i) => ({ key, value: { name: `c${i}` }, ttlMs: 500 })));

    const hits = await a.getMany(keys);
    expect(hits.size).toBe(200);
    expect(hits.get("platform:evm:199")?.value).toEqual({ name: "c199" });
  });
});

describe("cascade on user delete", () => {
  it("deleting a user also clears their token rows, ref rows and cache (no FK conflict)", async () => {
    const db = getDb(env);
    const store = storeFor(USER_A);
    await store.create(seed("USDC"), [USDC_ETH, USDC_UP]);
    await cacheFor(USER_A).put("warm", [], 500);

    // snapshot_balances.token_id deliberately has no FK so this step isn't held back by history rows.
    await expect(db.delete(user).where(eq(user.id, USER_A))).resolves.toBeDefined();
    expect(await db.select().from(tokens).where(eq(tokens.userId, USER_A))).toHaveLength(0);
  });
});
