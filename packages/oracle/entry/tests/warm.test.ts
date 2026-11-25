import type { UpstreamToken } from "@folio/oracle-basic";
import { PRICE_TTL_MS, WARM_TTL_MS } from "@folio/oracle-basic";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { candidatesBySymbol, warmCatalogue } from "../src/tokens/candidates";
import {
  makeCatalogue,
  refreshWarmCatalogue,
  topByRank,
  warmMarkets,
} from "../src/tokens/catalogue";
import { pickByConfidence } from "../src/tokens/mint";
import { WARM_KEY } from "../src/tokens/warm";
import { harness, now0, upstreamDown } from "./fakes";

// The warm blob: one `warm` key in the per-user cache table shared by three readers. Imports `../src/*` and passes fake ports as
// arguments (the functions' `R` is `never`, so a service's dependencies do not leak). The readers live in the files that use them
// but their criteria are a set of contrasts, so they are tested together.

const coin = (id: string, symbol: string, rank?: number): UpstreamToken => ({
  ref: `src/issued:${id}`,
  symbol,
  name: symbol,
  price: { unitPrice: 1, marketCapRank: rank, asOf: 0 },
});

const setup = (markets: UpstreamToken[] = []) => {
  const h = harness();
  h.upstream.markets = markets;
  return h;
};

describe("warm goes through SWR, one whole write", () => {
  it("three tokens in one write; no upstream fetch until it expires", async () => {
    const h = setup([
      coin("bitcoin", "BTC", 1),
      coin("ethereum", "ETH", 2),
      coin("tether", "USDT", 3),
    ]);
    await h.run(
      Effect.gen(function* () {
        expect(yield* warmMarkets(h.cache, h.upstream, 50)).toHaveLength(3);
        expect(h.cache.writes).toBe(1); // three tokens, one write
        expect(h.cache.entries.size).toBe(1);

        yield* warmMarkets(h.cache, h.upstream, 50);
        expect(h.upstream.calls).toEqual(["fetchMarkets:50"]); // fetched only once
      }),
    );
  });

  it("TTL is stamped by the catalogue's lifetime, not the price's", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(warmMarkets(h.cache, h.upstream, 10));

    expect(h.cache.entries.get(WARM_KEY)?.expiresAt).toBe(now0 + WARM_TTL_MS);
    // The catalogue is as static as chain/venue names and logos, far longer-lived than prices.
    expect(WARM_TTL_MS).toBeGreaterThan(PRICE_TTL_MS * 10);
  });

  it("showcase: refetches only when the price is old; the criterion is the blob's asOf, not the cache entry's expiry", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* warmMarkets(h.cache, h.upstream, 50);
        // Far earlier than WARM_TTL_MS (one week); the entry itself has not expired
        yield* TestClock.adjust(Duration.millis(PRICE_TTL_MS + 1));
        yield* warmMarkets(h.cache, h.upstream, 50);
        expect(h.upstream.calls).toHaveLength(2);
      }),
    );
  });

  it("upstream down: serves the old blob, no throw (SWR covers it)", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* warmMarkets(h.cache, h.upstream, 50);
        yield* TestClock.adjust(Duration.millis(PRICE_TTL_MS + 1));
        h.upstream.fail = upstreamDown();
        expect(yield* warmMarkets(h.cache, h.upstream, 50)).toHaveLength(1);
      }),
    );
  });
});

// The other reader of the same blob sits on the write path (mint's symbol tier), so its criterion differs: use what exists however
// old, so near-static data like "which token is POL" does not block the user on 4 catalogue requests. "Never refetches however old /
// fetches once cold / empty when cold fetch fails" is tested via `CandidateSource` in candidates.test; only the shared blob is here.
describe("catalogue reader: uses what exists, fetches once only when there is nothing", () => {
  it("after the showcase refreshes, the catalogue reader sees the new blob (same key, not two caches)", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* warmCatalogue(h.cache, h.upstream, 50);

        yield* TestClock.adjust(Duration.millis(PRICE_TTL_MS + 1));
        h.upstream.markets = [coin("bitcoin", "BTC", 1), coin("newcoin", "NEW", 900)];
        yield* warmMarkets(h.cache, h.upstream, 50); // the user opens the dropdown: refresh

        expect(yield* warmCatalogue(h.cache, h.upstream, 50)).toHaveLength(2);
        expect([...h.cache.entries.keys()]).toEqual(["warm"]);
      }),
    );
  });
});

// The third reader runs in the background after sync; without it, a user who never opens the picker keeps a catalogue frozen at first sync.
describe("background warm: refreshes only when the catalogue is old", () => {
  it("within a week: zero requests (most syncs land here)", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* refreshWarmCatalogue(h.cache, h.upstream, 50);
        yield* TestClock.adjust(Duration.millis(WARM_TTL_MS - 1));
        yield* refreshWarmCatalogue(h.cache, h.upstream, 50);
        expect(h.upstream.calls).toHaveLength(1);
      }),
    );
  });

  it("over a week: refreshes the whole blob once", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* refreshWarmCatalogue(h.cache, h.upstream, 50);
        yield* TestClock.adjust(Duration.millis(WARM_TTL_MS + 1));
        h.upstream.markets = [coin("bitcoin", "BTC", 1), coin("newcoin", "NEW", 900)];
        expect(yield* refreshWarmCatalogue(h.cache, h.upstream, 50)).toHaveLength(2);
        expect(h.upstream.calls).toHaveLength(2);
      }),
    );
  });

  it("after the refresh, mint's candidate source sees the new token at once: the reason it exists", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* warmCatalogue(h.cache, h.upstream, 50); // the blob built at first sync

        yield* TestClock.adjust(Duration.millis(WARM_TTL_MS + 1));
        h.upstream.markets = [coin("bitcoin", "BTC", 1), coin("newcoin", "NEW", 900)];
        yield* refreshWarmCatalogue(h.cache, h.upstream, 50); // background warm

        const rows = yield* warmCatalogue(h.cache, h.upstream, 50);
        expect(candidatesBySymbol(rows, "NEW")).toEqual([
          { ref: "src/issued:newcoin", marketCapRank: 900 },
        ]);
      }),
    );
  });

  it("background refresh fails: serves the old blob, no throw (it runs in waitUntil and must not break sync wrap-up)", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* refreshWarmCatalogue(h.cache, h.upstream, 50);
        yield* TestClock.adjust(Duration.millis(WARM_TTL_MS + 1));
        h.upstream.fail = upstreamDown();
        expect(yield* refreshWarmCatalogue(h.cache, h.upstream, 50)).toHaveLength(1);
      }),
    );
  });
});

// The queue's `catalogue` job calls `makeCatalogue(...).refreshCatalogue()`: peeks `asOf` and skips decoding the catalogue when
// fresh enough; its criterion must match the group above.
describe("refreshCatalogue(): fresh enough means only look at asOf", () => {
  const refresh = (h: ReturnType<typeof setup>) =>
    makeCatalogue(h.cache, h.upstream).refreshCatalogue();

  it("within a week: zero requests, returns the count deduped by ref; over a week refreshes the whole blob once", async () => {
    const h = setup([coin("bitcoin", "BTC", 1), coin("bitcoin", "BTC", 1), coin("eth", "ETH", 2)]);
    await h.run(
      Effect.gen(function* () {
        expect(yield* refresh(h)).toBe(2); // cold: fetch, the written blob has 2 entries after dedupe
        yield* TestClock.adjust(Duration.millis(WARM_TTL_MS));
        expect(yield* refresh(h)).toBe(2); // exactly one week: still fresh (same as `> WARM_TTL_MS`)
        expect(h.upstream.calls).toHaveLength(1);
        yield* TestClock.adjust(Duration.millis(1));
        h.upstream.markets = [coin("bitcoin", "BTC", 1)];
        expect(yield* refresh(h)).toBe(1);
        expect(h.upstream.calls).toHaveLength(2);
      }),
    );
  });

  it("asOf not a number / rows not an array: treated as a miss, takes the full path and refetches", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* h.cache.put(WARM_KEY, { asOf: "yesterday", rows: [] }, WARM_TTL_MS);
        expect(yield* refresh(h)).toBe(1);
        yield* h.cache.put(WARM_KEY, { asOf: now0, rows: "nope" }, WARM_TTL_MS);
        expect(yield* refresh(h)).toBe(1);
        expect(h.upstream.calls).toHaveLength(2);
      }),
    );
  });
});

describe("leaderboard and symbol candidates come from the same rows", () => {
  it("top N by market cap ascending, unranked last", async () => {
    const h = setup([
      coin("tether", "USDT", 3),
      coin("nameless", "XXX"),
      coin("bitcoin", "BTC", 1),
    ]);
    const rows = await h.run(warmMarkets(h.cache, h.upstream, 50));

    expect(topByRank(rows, 2).map((r) => r.info.ref)).toEqual([
      "src/issued:bitcoin",
      "src/issued:tether",
    ]);
    expect(topByRank(rows, 9).at(-1)?.info.ref).toBe("src/issued:nameless");
  });

  it("candidates by symbol store no extra copy: still one key in the cache", async () => {
    const h = setup([coin("usd-coin", "USDC", 6), coin("fake-usdc", "usdc", 4200)]);
    const rows = await h.run(warmMarkets(h.cache, h.upstream, 50));

    expect(candidatesBySymbol(rows, "usdc")).toEqual([
      { ref: "src/issued:usd-coin", marketCapRank: 6 },
      { ref: "src/issued:fake-usdc", marketCapRank: 4200 },
    ]);
    expect([...h.cache.entries.keys()]).toEqual(["warm"]);
  });

  // The same token may appear twice (upstream pages come from different snapshots). Without dedupe it silently competes against
  // itself in disambiguation and is never recognised, so the read side dedupes too rather than relying on upstream.
  it("the same token twice in the catalogue: only one candidate kept", async () => {
    const h = setup([coin("usd-coin", "USDC", 6), coin("usd-coin", "USDC", 6)]);
    const rows = await h.run(warmMarkets(h.cache, h.upstream, 50));

    expect(candidatesBySymbol(rows, "USDC")).toEqual([
      { ref: "src/issued:usd-coin", marketCapRank: 6 },
    ]);
  });

  // Dedupe must be on the read side: a dirty blob stored before the fix is refreshed only weekly.
  it("already dirty in cache: reads back clean, with no upstream fetch for it", async () => {
    const h = setup();
    const row = {
      info: { ref: "src/issued:usd-coin", symbol: "USDC", name: "USDC" },
      price: { unitPrice: 1, asOf: now0 },
    };
    await h.run(
      Effect.gen(function* () {
        yield* h.cache.put(WARM_KEY, { asOf: now0, rows: [row, row] }, WARM_TTL_MS);
        const rows = yield* warmMarkets(h.cache, h.upstream, 50);
        expect(rows).toHaveLength(1);
        expect(h.upstream.calls).toEqual([]); // healing dirty data must not cost a fetch
      }),
    );
  });

  it("a duplicated token is still recognised: otherwise it would lose to itself", async () => {
    // Rank 592: not top-50 trusted, only dominance can settle it; competing against itself gives ratio 1 and no recognition.
    const h = setup([coin("collector-crypt", "CARDS", 592), coin("collector-crypt", "CARDS", 592)]);
    const rows = await h.run(warmMarkets(h.cache, h.upstream, 50));

    expect(pickByConfidence(candidatesBySymbol(rows, "CARDS"))).toBe("src/issued:collector-crypt");
  });
});

// The cache may hold an older version's shape (or a hand edit): decoded via Schema; undecodable counts as absent and refetches.
describe("old / bad shape is a miss and heals", () => {
  it("blob missing a field: treated as no cache, fetches and writes a fresh one", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        // Missing `price.asOf`: an `Array.isArray(rows)` check would let it pass.
        yield* h.cache.put(
          WARM_KEY,
          {
            asOf: now0,
            rows: [{ info: { ref: "src/issued:x", symbol: "X", name: "X" }, price: {} }],
          },
          WARM_TTL_MS,
        );
        const rows = yield* warmCatalogue(h.cache, h.upstream, 50);
        expect(rows.map((r) => r.info.ref)).toEqual(["src/issued:bitcoin"]);
        expect(h.upstream.calls).toHaveLength(1);
      }),
    );
  });
});

describe("clearing the whole table", () => {
  it("nothing breaks; the next access refills it", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* warmMarkets(h.cache, h.upstream, 50);

        h.cache.entries.clear();
        expect(yield* warmMarkets(h.cache, h.upstream, 50)).toHaveLength(1);
        expect(h.upstream.calls).toHaveLength(2);
      }),
    );
  });
});
