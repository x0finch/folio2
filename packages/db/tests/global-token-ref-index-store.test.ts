import { env } from "cloudflare:test";
import { tokenRef } from "@folio/oracle-ref";
import { Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { diffRefIndexPage, type RefIndexRow, refKey } from "../src/domains/global-ref-index";
import { globalTokenRefIndex } from "../src/schema";
import { forGlobal } from "./effect";

// Real-D1 tests for `global_token_ref_index`. No userId: no user data, only public upstream knowledge (a controlled exception to user scoping). Two refs per row: chain_ref and the upstream ref (split into upstream / upstream_local_name).
//
// `putAll` writes diffs: compared with the upstream full set, only really changed rows (rename / add / delist) are written, so steady state is ~0 writes. The "diff write" section pins this; the rest verify the read path.

const CGK = "coingecko";
const CMC = "coinmarketcap";
const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_SOL = "solana/contract:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// The whole upstream ref (the table stores and lookup returns the whole ref, not a bare id).
const cgk = (id: string) => tokenRef.issued(CGK, id);
const cmc = (id: string) => tokenRef.issued(CMC, id);

beforeEach(async () => {
  await getDb(env).delete(globalTokenRefIndex);
});

// The production path (`GlobalDatabase`); the handle just lets cases `await s.xxx(...)`. The global table isn't user-scoped, so there is no `CurrentUser` to give.
const store = forGlobal((db) => db.refIndex);

const rowCount = async () => (await getDb(env).select().from(globalTokenRefIndex)).length;

describe("full load + forward lookup", () => {
  it("after loading, a lookup by (upstream, chainRef) returns the whole upstream ref; missed keys don't appear", async () => {
    const s = store();
    await s.putAll(
      [
        { chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") },
        { chainRef: USDC_SOL, upstreamRef: cgk("usd-coin") },
      ],
      1000,
    );
    const got = await s.lookup(CGK, [USDC_ETH, USDC_SOL, "evm:1/contract:0xdead"]);
    expect(got.get(USDC_ETH)).toBe(cgk("usd-coin"));
    expect(got.get(USDC_SOL)).toBe(cgk("usd-coin"));
    expect(got.has("evm:1/contract:0xdead")).toBe(false);
    expect(got.size).toBe(2);
  });

  // upstream_local_name stores the canonical form of the tokenRef's localName (issued:usd-coin), not a bare id.
  it("stored as (upstream, upstream_local_name), the latter canonical not a bare id", async () => {
    const s = store();
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    const [row] = await getDb(env).select().from(globalTokenRefIndex);
    expect(row.chainRef).toBe(USDC_ETH);
    expect(row.upstream).toBe(CGK);
    expect(row.upstreamLocalName).toBe("issued:usd-coin"); // not the bare "usd-coin"
  });

  it("another upstream finds nothing: the primary key includes upstream, so each has its own set", async () => {
    const s = store();
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    expect((await s.lookup(CMC, [USDC_ETH])).size).toBe(0);
  });

  it("one address can carry both upstreams' names; refreshing one leaves the other", async () => {
    const s = store();
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    // Refreshing CMC (diff scoped by upstream): no CGK row may be scanned, let alone deleted.
    const counts = await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cmc("3408") }], 1000);
    expect(counts).toEqual({ updated: 0, inserted: 1, deleted: 0 });
    expect((await s.lookup(CGK, [USDC_ETH])).get(USDC_ETH)).toBe(cgk("usd-coin"));
    expect((await s.lookup(CMC, [USDC_ETH])).get(USDC_ETH)).toBe(cmc("3408"));
  });

  it("empty input doesn't query, empty rows aren't written", async () => {
    const s = store();
    expect((await s.lookup(CGK, [])).size).toBe(0);
    expect(await s.putAll([], 1000)).toEqual({ updated: 0, inserted: 0, deleted: 0 });
    expect(await rowCount()).toBe(0);
  });
});

describe("normalised before lookup", () => {
  // chain_ref is stored in canonical form; callers' strings may differ in case and would miss without normalising.
  it("EVM address case doesn't affect hits; the returned key is the caller's original string", async () => {
    const s = store();
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    const upper = "EVM:1/contract:0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48";
    const got = await s.lookup(CGK, [upper]);
    // The key must be the input string: callers use it for .get().
    expect(got.get(upper)).toBe(cgk("usd-coin"));
  });

  it("unparseable strings are neither queried nor thrown", async () => {
    const s = store();
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    const got = await s.lookup(CGK, ["nonsense", "a/b/c", USDC_ETH]);
    expect(got.size).toBe(1);
    expect(got.get(USDC_ETH)).toBe(cgk("usd-coin"));
  });
});

describe("diff write", () => {
  const ethRow = { chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") };
  const solRow = { chainRef: USDC_SOL, upstreamRef: cgk("usd-coin") };

  it("when the db already holds the upstream full set, refreshing again writes 0 (the quota saver)", async () => {
    const s = store();
    await s.putAll([ethRow, solRow], 1000);
    const counts = await s.putAll([ethRow, solRow], 2000);
    expect(counts).toEqual({ updated: 0, inserted: 0, deleted: 0 });
    // Nothing written, so updated_at stays at the first refresh's 1000.
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(1000));
  });

  it("a renamed ref updates only that row", async () => {
    const s = store();
    await s.putAll([ethRow], 1000);
    const counts = await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin-v2") }], 2000);
    expect(counts).toEqual({ updated: 1, inserted: 0, deleted: 0 });
    expect((await s.lookup(CGK, [USDC_ETH])).get(USDC_ETH)).toBe(cgk("usd-coin-v2"));
    expect(await rowCount()).toBe(1);
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(2000));
  });

  it("a new upstream entry inserts a new row, the old row untouched", async () => {
    const s = store();
    await s.putAll([ethRow], 1000);
    const counts = await s.putAll([ethRow, solRow], 2000);
    expect(counts).toEqual({ updated: 0, inserted: 1, deleted: 0 });
    expect(await rowCount()).toBe(2);
  });

  it("a delisted upstream entry deletes that row", async () => {
    const s = store();
    await s.putAll([ethRow, solRow], 1000);
    // This round upstream only has ETH; SOL is delisted.
    const counts = await s.putAll([ethRow], 2000);
    expect(counts).toEqual({ updated: 0, inserted: 0, deleted: 1 });
    expect(await rowCount()).toBe(1);
    expect((await s.lookup(CGK, [USDC_SOL])).size).toBe(0);
    expect((await s.lookup(CGK, [USDC_ETH])).get(USDC_ETH)).toBe(cgk("usd-coin"));
  });

  it("rename + add + delist in one round: counts line up", async () => {
    const s = store();
    const A = "evm:1/contract:0x000000000000000000000000000000000000000a";
    const B = "evm:1/contract:0x000000000000000000000000000000000000000b";
    const C = "evm:1/contract:0x000000000000000000000000000000000000000c";
    await s.putAll(
      [
        { chainRef: A, upstreamRef: cgk("a") },
        { chainRef: B, upstreamRef: cgk("b") },
      ],
      1000,
    );
    // A renamed, B delisted, C added.
    const counts = await s.putAll(
      [
        { chainRef: A, upstreamRef: cgk("a2") },
        { chainRef: C, upstreamRef: cgk("c") },
      ],
      2000,
    );
    expect(counts).toEqual({ updated: 1, inserted: 1, deleted: 1 });
    expect((await s.lookup(CGK, [A])).get(A)).toBe(cgk("a2"));
    expect((await s.lookup(CGK, [B])).size).toBe(0);
    expect((await s.lookup(CGK, [C])).get(C)).toBe(cgk("c"));
  });

  it("**an empty upstream full set never clears the table**: a suspicious empty response is a no-op", async () => {
    const s = store();
    await s.putAll([ethRow, solRow], 1000);
    const counts = await s.putAll([], 2000);
    expect(counts).toEqual({ updated: 0, inserted: 0, deleted: 0 });
    expect(await rowCount()).toBe(2); // not cleared
  });

  it("deletes are scoped by upstream: refreshing CGK doesn't touch CMC rows", async () => {
    const s = store();
    await s.putAll([ethRow], 1000); // CGK
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cmc("3408") }], 1000); // CMC has its own set
    // Refresh CGK again with CGK fully delisted (empty CGK set but non-empty payload): only the CGK row goes, CMC stays.
    const counts = await s.putAll([{ chainRef: USDC_SOL, upstreamRef: cgk("usd-coin") }], 2000);
    expect(counts).toEqual({ updated: 0, inserted: 1, deleted: 1 }); // delete ETH@CGK, add SOL@CGK
    expect((await s.lookup(CMC, [USDC_ETH])).get(USDC_ETH)).toBe(cmc("3408")); // CMC untouched
    expect((await s.lookup(CGK, [USDC_ETH])).size).toBe(0); // CGK's ETH is delisted
  });

  it("keyset pagination across pages (>5000 rows): the cursor misses no rows and the last page's changes are persisted", async () => {
    const s = store();
    const N = 5001; // > PAGE_ROWS (5000): forces two pages
    const chainRef = (i: number) => `evm:1/contract:0x${i.toString(16).padStart(40, "0")}`;
    const first = Array.from({ length: N }, (_, i) => ({
      chainRef: chainRef(i),
      upstreamRef: cgk(`c-${i}`),
    }));
    const ins = await s.putAll(first, 1000);
    expect(ins).toEqual({ updated: 0, inserted: N, deleted: 0 });
    expect(await rowCount()).toBe(N);

    // Change the last row (likely on page 2 after sorting) and delete the first; the rest are unchanged.
    const last = first.length - 1;
    const second = first
      .filter((_, i) => i !== 0)
      .map((r, i) => (i === last - 1 ? { ...r, upstreamRef: cgk("changed") } : r));
    const counts = await s.putAll(second, 2000);
    expect(counts).toEqual({ updated: 1, inserted: 0, deleted: 1 });
    expect(await rowCount()).toBe(N - 1);
    expect((await s.lookup(CGK, [chainRef(0)])).size).toBe(0); // first row deleted
    expect((await s.lookup(CGK, [chainRef(last)])).get(chainRef(last))).toBe(cgk("changed"));
  });
});

describe("refresh time", () => {
  it("null if never refreshed; once refreshed, the max updated_at among that upstream's rows (advances only on real changes)", async () => {
    const s = store();
    expect(await s.refreshedAt(CGK)).toEqual(Option.none());

    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(1000));
    expect(await s.refreshedAt(CMC)).toEqual(Option.none()); // the other upstream was never refreshed

    // Refreshing the same full set again: 0 writes, so the time doesn't move (it drifts to "last time anything changed").
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 5000);
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(1000));

    // Only a real change advances it.
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin-v2") }], 9000);
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(9000));
  });
});

describe("diffRefIndexPage (pure function)", () => {
  const row = (chainRef: string, name: string): RefIndexRow => ({
    chainRef,
    upstream: CGK,
    upstreamLocalName: name,
  });
  const expectedOf = (rows: RefIndexRow[]) =>
    new Map(rows.map((r) => [refKey(r.chainRef, r.upstream), r]));

  it("identical: empty output, and all expectations consumed (what's left is the additions)", () => {
    const expected = expectedOf([row("a", "issued:a"), row("b", "issued:b")]);
    const page = [row("a", "issued:a"), row("b", "issued:b")];
    expect(diffRefIndexPage(expected, page)).toEqual({ updates: [], deletes: [] });
    expect(expected.size).toBe(0); // all hit, no additions
  });

  it("a renamed ref: 1 update (carrying the expected one)", () => {
    const expected = expectedOf([row("a", "issued:a-new")]);
    const page = [row("a", "issued:a-old")];
    const diff = diffRefIndexPage(expected, page);
    expect(diff.deletes).toEqual([]);
    expect(diff.updates).toEqual([row("a", "issued:a-new")]);
    expect(expected.size).toBe(0);
  });

  it("in the db but not expected: 1 delete", () => {
    const expected = expectedOf([]);
    const page = [row("a", "issued:a")];
    expect(diffRefIndexPage(expected, page)).toEqual({
      updates: [],
      deletes: [{ chainRef: "a", upstream: CGK }],
    });
  });

  it("expected but not in the db: not emitted on this page, left in expected (the caller inserts after the scan)", () => {
    const expected = expectedOf([row("a", "issued:a"), row("b", "issued:b")]);
    const page = [row("a", "issued:a")]; // only a is in the db
    const diff = diffRefIndexPage(expected, page);
    expect(diff).toEqual({ updates: [], deletes: [] });
    expect([...expected.values()]).toEqual([row("b", "issued:b")]); // b is an addition
  });
});
