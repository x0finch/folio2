import { env } from "cloudflare:test";
import { type Balance, ConnectorFailure } from "@folio/connectors-basic";
import { Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFor, globalDb, oracleDbFor } from "./db-effect";
import { refreshCatalogueFor, syncOne, syncRound } from "./sync-fns";

// End to end for the mint write path: provider balances in -> persisted -> snapshot rows carry the right token_id.
// Real D1, not an in-memory fake: the risk is real table constraints (`token_refs` primary key, upsert-then-read under concurrency).
// The upstream is stubbed to throw: mint never touches the network.

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

// Counts outbound calls as well as throwing: SWR swallows a throw as "upstream has none", so a throw alone wouldn't fail a case.
let outbound: string[] = [];

beforeEach(async () => {
  await resetUser();
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    outbound.push(String(input));
    throw new Error(`write path must not touch the network, but requested ${String(input)}`);
  });
});

afterEach(() => vi.restoreAllMocks());

// Seeds a warm set in the warm cache so the symbol tier has local candidates (else it would try to go back to source).
async function seedWarm(
  rows: { id: string; symbol: string; rank: number }[],
  asOf = Date.now(),
): Promise<void> {
  await dbFor(USER).cache.put(
    "warm",
    {
      asOf,
      rows: rows.map((r) => ({
        info: { ref: `${NAMER}/issued:${r.id}`, symbol: r.symbol, name: r.symbol },
        price: { unitPrice: 1, marketCapRank: r.rank, asOf: Date.now() },
      })),
    },
    60 * 60 * 1000,
  );
}

// Whether the upstream recognized that Token: reads the current namer's row in `token_refs` (the port returns an `Option`, unwrapped here).
const tokenInfo = async (tokenId: string) =>
  Option.getOrUndefined(await oracleDbFor(USER).tokens.getById(tokenId));

async function seedRefIndex(rows: { ref: string; localName: string }[]): Promise<void> {
  // chainRef -> the whole upstream ref (the table stores the whole ref, not a bare id).
  await globalDb.refIndex.putAll(
    rows.map((r) => ({ chainRef: r.ref, upstreamRef: `${NAMER}/issued:${r.localName}` })),
    Date.now(),
  );
}

async function makeAccount(label = "w"): Promise<string> {
  const account = await dbFor(USER).accounts.create({
    connectorId: "evm",
    label,
    creds: null,
  });
  return account.id;
}

// A balance as the provider reports it (`Balance` shape, what the orchestrator receives).
const bal = (tokenRef: string, symbol: string, over: Record<string, unknown> = {}): Balance =>
  ({
    symbol,
    amount: 1,
    value: 100,
    kind: "spot" as const,
    tokenRef,
    ...over,
  }) as Balance;

// Runs the real orchestrator (mint is its own step before revalue). Only fetching is stubbed, so mint / revalue /
// snapshot writes are real and ordering and best-effort semantics are covered without re-implementing orchestration here.
async function syncWith(balances: Balance[], accountId: string): Promise<string> {
  const accounts = await dbFor(USER).accounts.list();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`no such account ${accountId}`);
  const res = await syncOne(USER, { account, balances });
  if (!res.ok || !res.snapshotId) throw new Error(`sync failed: ${res.error ?? "no snapshot"}`);
  return res.snapshotId;
}

async function balancesOf(snapshotId: string) {
  // symbol / token_ref no longer live on snapshots: identity is only token_id; the upstream naming is looked up via store.getById().ref.
  const { results } = await env.DB.prepare(
    "SELECT token_id as tokenId FROM snapshot_balances WHERE snapshot_id = ?",
  )
    .bind(snapshotId)
    .all<{ tokenId: string | null }>();
  return results;
}

describe("snapshot rows carry token_id after persisting", () => {
  it("contract known to the mapping table -> upstream coin recognized, snapshot row has token_id", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal(USDC_ETH, "USDC")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenId).toBeTruthy();

    // That Token really was recognized upstream (has a ref row under the coingecko namer).
    const info = await tokenInfo(rows[0].tokenId as string);
    expect(info?.ref).toBe("coingecko/issued:usd-coin");
  });

  it("contract absent from the mapping table -> row still created, snapshot still written, just not recognized upstream", async () => {
    const accountId = await makeAccount();
    const snapshotId = await syncWith([bal("evm:1/contract:0xdeadbeef", "SCAM")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows[0].tokenId).toBeTruthy(); // has a token_id even unrecognized; the snapshot doesn't block on upstream
    const info = await tokenInfo(rows[0].tokenId as string);
    expect(info?.ref).toBeNull();
  });

  it("native coin goes through the symbol tier (by design it isn't in the mapping table)", async () => {
    await seedWarm([{ id: "ethereum", symbol: "ETH", rank: 2 }]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal("evm:1/native", "ETH")], accountId);

    const rows = await balancesOf(snapshotId);
    expect((await tokenInfo(rows[0].tokenId as string))?.ref).toBe("coingecko/issued:ethereum");
  });

  // A contract's symbol is whatever the deployer typed: an address lookup miss must honestly stay unrecognized.
  it("a lookalike contract with symbol USDC must not merge into the real USDC", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    await seedWarm([{ id: "usd-coin", symbol: "USDC", rank: 6 }]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith(
      [bal(USDC_ETH, "USDC"), bal("evm:1/contract:0xfake", "USDC")],
      accountId,
    );

    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(2);
    expect(rows[0].tokenId).not.toBe(rows[1].tokenId); // one row each
  });

  // A `coingecko/<id>` ref is already the upstream's own naming (the user picked a coin manually), so it is the anchor.
  // Without the short-circuit the same ref ends up twice in one batch and the real table's `token_refs` primary key clashes,
  // failing the whole account's snapshot write; an in-memory Map fake swallows that, so this must run on real D1.
  it("upstream-named ref (coin picked manually) -> is its own anchor, yields one ref row", async () => {
    const accountId = await makeAccount();
    const snapshotId = await syncWith([bal("coingecko/issued:usd-coin", "USDC")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows[0].tokenId).toBeTruthy();

    const info = await tokenInfo(rows[0].tokenId as string);
    expect(info?.ref).toBe("coingecko/issued:usd-coin");
    // Only one ref row: dedupe worked (else the primary key would clash).
    const { results } = await env.DB.prepare(
      "SELECT count(*) as n FROM token_refs WHERE user_id = ? AND token_id = ?",
    )
      .bind(USER, rows[0].tokenId)
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  // USDC from six sources lands on one Token (multi-chain same coin: one Token + several refs); covered in memory by mint.test.ts,
  // this checks it holds on the real table: six ref rows, one token, and the `token_refs` primary key never clashes.
  it("USDC from six sources -> one Token, six ref rows", async () => {
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
        bal("binance/issued:USDC", "USDC"),
        bal("okx/issued:USDC", "USDC"),
        bal("coingecko/issued:usd-coin", "USDC"),
      ],
      accountId,
    );

    const rows = await balancesOf(snapshotId);
    expect(new Set(rows.map((r) => r.tokenId)).size).toBe(1); // all land on one Token
    const { results } = await env.DB.prepare(
      "SELECT count(*) as n FROM token_refs WHERE user_id = ? AND token_id = ?",
    )
      .bind(USER, rows[0].tokenId)
      .all<{ n: number }>();
    expect(results[0].n).toBe(6); // one row per source
  });
});

describe("perp rows both have token_id", () => {
  it("equity row and single-position row both get token_id", async () => {
    await seedWarm([{ id: "usd-coin", symbol: "USDC", rank: 6 }]);
    const accountId = await makeAccount("perp");

    const snapshotId = await syncWith(
      [
        bal("hyperliquid/issued:USDC", "USDC", { kind: "perp_equity" }),
        // The single-position row has zero amount and isn't aggregated, but should still have an identity.
        bal("hyperliquid/issued:BTC", "BTC", { kind: "perp_position", usdValue: 0 }),
      ],
      accountId,
    );

    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tokenId)).toBe(true);
  });
});

describe("per-account independent persistence still holds", () => {
  it("one account failing doesn't stop the other from persisting", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    const bad = await makeAccount("bad");
    const good = await makeAccount("good");
    const accounts = await dbFor(USER).accounts.list();
    const of = (id: string) => accounts.find((a) => a.id === id) as never;

    // Two accounts in the same round: the bad one's fetch fails (a `ConnectorError` on the error channel) -> syncAccount
    // settles it as ok:false, writes nothing, doesn't throw; the good one still persists with its token_id.
    const [badRes, goodRes] = await syncRound(USER, [
      { account: of(bad), fail: new ConnectorFailure({ message: "provider down" }) },
      { account: of(good), balances: [bal(USDC_ETH, "USDC")] },
    ]);
    expect(badRes.ok).toBe(false);
    expect(goodRes.snapshotId).toBeTruthy();
    expect((await balancesOf(goodRes.snapshotId as string))[0].tokenId).toBeTruthy();
  });

  // Accounts run concurrently, so the same ref is minted at once; the store's upsert-then-read converges idempotently, no barrier.
  it("two accounts concurrently persist the same coin -> only one Token row", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    const a = await makeAccount("a");
    const b = await makeAccount("b");

    // One round each, run at the same time -- the shape of two requests arriving together.
    const [s1, s2] = await Promise.all([
      syncWith([bal(USDC_ETH, "USDC")], a),
      syncWith([bal(USDC_ETH, "USDC")], b),
    ]);

    const [r1, r2] = [await balancesOf(s1), await balancesOf(s2)];
    expect(r1[0].tokenId).toBe(r2[0].tokenId);
    const { results } = await env.DB.prepare("SELECT count(*) as n FROM tokens WHERE user_id = ?")
      .bind(USER)
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });
});

describe("provider-reported metadata goes into the token row", () => {
  // Name and image are dropped by orchestration (snapshots don't store them), so they're a seed captured when balances are fetched.
  it("row creation uses the provider's name / logo (image goes to the fallback slot)", async () => {
    const accountId = await makeAccount();
    // The seed is captured in `fetchViaConnector`; this test swaps the whole balance-fetch layer, bypassing it,
    // so there is no seed here, which exercises the "fall back to symbol alone without a seed" path.
    const snapshotId = await syncWith([bal("evm:1/contract:0xnoseed", "FOO")], accountId);
    const rows = await balancesOf(snapshotId);
    const info = await tokenInfo(rows[0].tokenId as string);
    // Without a seed it falls back to symbol alone: name equals symbol, not empty.
    expect(info).toMatchObject({ symbol: "FOO", name: "FOO" });
  });
});

// The write path doesn't go outbound for catalogue freshness. Symbol is LINK, not ETH: mainstream coins are in the
// curated table (OVERRIDES), which is consulted before candidate sources, so ETH would never query them and the assertion would spin idle.
describe("write path doesn't go outbound for catalogue freshness", () => {
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

  it("catalogue is a year old -> the symbol tier still recognizes it, zero outbound calls", async () => {
    await seedWarm([{ id: "chainlink", symbol: "LINK", rank: 15 }], Date.now() - YEAR_MS);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal("binance/issued:LINK", "LINK")], accountId);

    const rows = await balancesOf(snapshotId);
    expect((await tokenInfo(rows[0].tokenId as string))?.ref).toBe("coingecko/issued:chainlink");
    expect(outbound).toEqual([]); // <- the point of this case
  });

  it("symbol absent from the catalogue -> not recognized, snapshot still written (not blocked on upstream)", async () => {
    await seedWarm([{ id: "chainlink", symbol: "LINK", rank: 15 }], Date.now() - YEAR_MS);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal("binance/issued:ZZZ", "ZZZ")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows[0].tokenId).toBeTruthy(); // has an identity
    expect((await tokenInfo(rows[0].tokenId as string))?.ref).toBeNull(); // but upstream didn't recognize it
    expect(outbound).toEqual([]); // unrecognized, and upstream isn't asked either
  });
});

// The catalogue's only active follow-up path. Asserts whether the blob was replaced, not network call counts:
// counting by URL would include other `/coins/markets` calls and can't tell who made them.
describe("post-sync warming refreshes the catalogue", () => {
  const blobAsOf = async (): Promise<number | undefined> => {
    const hit = await dbFor(USER).cache.get("warm");
    return (Option.getOrUndefined(hit)?.value as { asOf: number } | undefined)?.asOf;
  };

  const marketsCalls = () => outbound.filter((u) => u.includes("/coins/markets")).length;
  const LINK = [{ id: "chainlink", symbol: "LINK", rank: 15 }];
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // Differential, not absolute: the two runs differ only in the catalogue's asOf, so the extra calls are its.
  it("stale catalogue triggers a refresh, a fresh one doesn't", async () => {
    await seedWarm(LINK, Date.now());
    await refreshCatalogueFor(USER);
    const fresh = marketsCalls();

    outbound.length = 0;
    await seedWarm(LINK, Date.now() - WEEK_MS - 1);
    await refreshCatalogueFor(USER);
    const stale = marketsCalls();

    expect(stale).toBeGreaterThan(fresh);
  });

  it("a fresh one is left completely untouched", async () => {
    const fresh = Date.now();
    await seedWarm(LINK, fresh);

    await refreshCatalogueFor(USER);

    expect(await blobAsOf()).toBe(fresh);
  });

  it("warming tries to refresh but upstream is down -> old catalogue is kept, the job doesn't throw (best-effort warming)", async () => {
    const stale = Date.now() - WEEK_MS - 1;
    await seedWarm(LINK, stale);

    await expect(refreshCatalogueFor(USER)).resolves.toBeUndefined();

    expect(await blobAsOf()).toBe(stale); // upstream stubbed to throw -> SWR keeps the old value, nothing written back
  });
});

describe("multi-row batches stay within D1's parameter limit", () => {
  // snapshot_balances now has 12 columns -> 8 rows per batch. Seeded with 25 rows across 4 batches.
  it("25 rows persisted at once, all with token_id", async () => {
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
