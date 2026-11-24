import {
  DAILY_FILL_DAYS_PER_CALL,
  dayBucketOf,
  MS_PER_DAY,
  PRICE_TTL_MS,
  type TokenInfo,
} from "@folio/oracle-basic";
import { Duration, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { TokenService } from "../src/tokens";
import { harness, now0, upstreamDown } from "./fakes";

const NOW = now0; // falls mid-way through a UTC day
const TODAY = Math.floor(NOW / MS_PER_DAY);
const SRC_BTC = "src/issued:bitcoin";

const info = (over: Partial<TokenInfo> & { id: string }): TokenInfo => ({
  ref: SRC_BTC,
  symbol: "BTC",
  name: "Bitcoin",
  infoStale: false, // refreshed by default; cases testing refresh pass true
  ...over,
});

const setup = (rows: TokenInfo[] = []) => harness({ seedRows: rows });

describe("enrichment: each store reads its own half, the service composes the row", () => {
  it("reads by token_id; input no longer needs symbol or tokenRef", async () => {
    const h = setup([
      info({ id: "tk_1", logo: "b.png" }),
      info({ id: "tk_2", ref: null, symbol: "WAT", name: "Whatever", providerLogo: "p.png" }),
    ]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* h.prices.put(
          [{ tokenId: "tk_1", unitPrice: 60000, marketCapRank: 1, asOf: NOW }],
          PRICE_TTL_MS,
        );

        const got = yield* tokens.enrich(["tk_1", "tk_2", "tk_missing"]);
        expect(got.size).toBe(2);
        expect(got.get("tk_1")).toMatchObject({ symbol: "BTC", logo: "b.png" });
        expect(got.get("tk_1")?.price).toMatchObject({
          unitPrice: 60000,
          marketCapRank: 1,
          stale: false,
        });
        expect(got.get("tk_2")?.price).toBeUndefined(); // a row without price still yields info
      }),
    );
  });

  it("empty input does not query the db", async () => {
    const h = setup();
    expect(await h.run(Effect.flatMap(TokenService, (t) => t.enrich([])))).toEqual(new Map());
  });

  it('"did upstream recognise it" is just whether ref is empty, no extra state', async () => {
    const h = setup([info({ id: "tk_1" }), info({ id: "tk_2", ref: null, symbol: "WAT" })]);
    const got = await h.run(Effect.flatMap(TokenService, (t) => t.enrich(["tk_1", "tk_2"])));

    expect(got.get("tk_1")?.ref).toBe(SRC_BTC);
    expect(got.get("tk_2")?.ref).toBeNull();
    const keys = Object.keys(got.get("tk_2") as object);
    expect(keys.some((k) => /cgk|coingecko|coin_?id|orphan|recheck/i.test(k))).toBe(false);
  });

  it("logo fallback chain: the source's first, else the connector's own", async () => {
    const h = setup([
      info({ id: "tk_1", logo: "up.png", providerLogo: "p.png" }),
      info({ id: "tk_2", logo: undefined, providerLogo: "p.png" }),
      info({ id: "tk_3", logo: undefined }),
    ]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        expect(yield* tokens.logoUrlById("tk_1")).toEqual(Option.some("up.png"));
        expect(yield* tokens.logoUrlById("tk_2")).toEqual(Option.some("p.png"));
        expect(yield* tokens.logoUrlById("tk_3")).toEqual(Option.none());
        expect(yield* tokens.logoUrlById("nope")).toEqual(Option.none());
      }),
    );
  });
});

describe("prices (the id tier): price table only, one read per batch, zero network", () => {
  it("fresh and stale are both served as is with the stale flag; ids absent from the table are not in the result", async () => {
    const h = setup([info({ id: "tk_1" }), info({ id: "tk_2", ref: "src/issued:ethereum" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* h.prices.put([{ tokenId: "tk_1", unitPrice: 60000, asOf: NOW }], PRICE_TTL_MS);
        yield* h.prices.put([{ tokenId: "tk_2", unitPrice: 3000, asOf: 0 }], 0);
        h.upstream.prices.set(SRC_BTC, { unitPrice: 61000, asOf: NOW });

        const got = yield* tokens.pricesOf(["tk_1", "tk_2", "tk_missing"]);
        expect(got.get("tk_1")).toMatchObject({ unitPrice: 60000, stale: false });
        expect(got.get("tk_2")).toMatchObject({ unitPrice: 3000, stale: true });
        expect(got.has("tk_missing")).toBe(false);
        // Stale does not refetch either: fetching belongs to `refreshStale` (the queue's prices job).
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  it("empty input gives an empty Map", async () => {
    const h = setup();
    expect(await h.run(Effect.flatMap(TokenService, (t) => t.pricesOf([])))).toEqual(new Map());
  });
});

describe("batch refresh of stale prices", () => {
  it("refreshes only recognised tokens with stale / missing price, in one batched fetch", async () => {
    const h = setup([
      info({ id: "fresh" }),
      info({ id: "stale", ref: "src/issued:ethereum" }),
      info({ id: "nopricexyz", ref: "src/issued:tether" }),
      info({ id: "unknown", ref: null }), // upstream did not recognise: skipped
    ]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* h.prices.put([{ tokenId: "fresh", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
        yield* h.prices.put([{ tokenId: "stale", unitPrice: 1, asOf: 0 }], 0);
        h.upstream.prices.set("src/issued:ethereum", { unitPrice: 3000, asOf: NOW });
        h.upstream.prices.set("src/issued:tether", { unitPrice: 1, asOf: NOW });

        expect(
          (yield* tokens.refreshStale(["fresh", "stale", "nopricexyz", "unknown"])).prices,
        ).toBe(2);
        // Asserts only what the price half asked; both halves run in one method.
        expect(h.upstream.calls.filter((c) => c.startsWith("fetchPrices"))).toEqual([
          "fetchPrices:src/issued:ethereum,src/issued:tether",
        ]);
      }),
    );
  });

  it("nothing to refresh: zero calls", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* h.prices.put([{ tokenId: "tk_1", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
        // Info is already refreshed too (`info()` defaults to infoStale: false), so neither half has a target;
        // degraded is false: "nothing to refresh" is distinguishable from "upstream down".
        const nothing = { prices: 0, infos: 0, degraded: false };
        expect(yield* tokens.refreshStale(["tk_1"])).toEqual(nothing);
        expect(yield* tokens.refreshStale([])).toEqual(nothing);
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  // One method, one convention: log a line, return 0, and carry "down" in the return value (`degraded`),
  // since "nothing to refresh" and "upstream down" differ for the caller.
  it("upstream down: returns 0 and degraded, does not throw", async () => {
    const h = setup([info({ id: "tk_1" })]);
    h.upstream.fail = upstreamDown();
    expect(await h.run(Effect.flatMap(TokenService, (t) => t.refreshStale(["tk_1"])))).toEqual({
      prices: 0,
      infos: 0,
      degraded: true,
    });
    expect(h.prices.current.size).toBe(0);
  });

  // The same ids are read from the store only once, not once per half.
  it("price and info share the two reads: store read once, price store read once", async () => {
    const h = setup([info({ id: "tk_1", infoStale: true })]);
    let storeReads = 0;
    const realGetByIds = h.store.getByIds;
    h.store.getByIds = (ids) => {
      storeReads += 1;
      return realGetByIds(ids);
    };
    await h.run(Effect.flatMap(TokenService, (t) => t.refreshStale(["tk_1"])));
    expect(storeReads).toBe(1);
  });
});

// Overwriting refresh of metadata (symbol/name/logo), separate from price refresh because the TTLs differ (30d / 30min).
// Overwrite is required: rows are built from connector metadata, and a contract's symbol is a deployer string that can go stale
// (MATIC after the POL rename); the contract ref was recognised by address and is trusted, only the display name is wrong.
// Without overwriting, one token would show different names depending on which account synced first.
describe("batch refresh of stale metadata (overwrite)", () => {
  it("refreshes only recognised tokens with stale info, in one batched fetch", async () => {
    const h = setup([
      info({ id: "fresh" }), // already refreshed: skipped
      info({ id: "stale", ref: "src/issued:ethereum", infoStale: true }),
      info({ id: "unknown", ref: null, infoStale: true }), // upstream did not recognise: no name to fetch, skipped
    ]);
    h.upstream.markets = [
      { ref: "src/issued:ethereum", symbol: "ETH", name: "Ethereum", logo: "eth.png" },
    ];
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        expect((yield* tokens.refreshStale(["fresh", "stale", "unknown"])).infos).toBe(1);
        // Same: only what the info half asked.
        expect(h.upstream.calls.filter((c) => c.startsWith("fetchTokens"))).toEqual([
          "fetchTokens:src/issued:ethereum",
        ]);
        // Not stale after the refresh, so the next call makes none (else every visit would refetch).
        expect(h.store.rows.get("stale")?.infoStale).toBe(false);
        expect((yield* tokens.refreshStale(["fresh", "stale", "unknown"])).infos).toBe(0);
        expect(h.upstream.calls.filter((c) => c.startsWith("fetchTokens"))).toEqual([
          "fetchTokens:src/issued:ethereum",
        ]);
      }),
    );
  });

  // Case is our display convention, not upstream's: CoinGecko gives lowercase `usdc` while rows are built uppercase; unnormalised,
  // a refresh would flip `USDC` to `usdc`, and symbol is also the disambiguation key (candidatesBySymbol), so both writers must agree.
  // Overwriting the upstream name is still right (MATIC to POL); case is not content.
  it("upstream's symbol is uppercased before writing (name copied as is, case not)", async () => {
    const h = setup([
      info({ id: "t1", ref: "src/issued:usd-coin", symbol: "USDC", infoStale: true }),
    ]);
    h.upstream.markets = [
      { ref: "src/issued:usd-coin", symbol: "usdc", name: "USDC", logo: "usdc.png" },
    ];

    expect((await h.run(Effect.flatMap(TokenService, (t) => t.refreshStale(["t1"])))).infos).toBe(
      1,
    );
    expect(h.store.rows.get("t1")?.symbol).toBe("USDC");
    expect(h.store.rows.get("t1")?.name).toBe("USDC");
    expect(h.store.rows.get("t1")?.logo).toBe("usdc.png");
  });

  it("on-chain symbol differs from upstream: upstream wins (MATIC to POL)", async () => {
    // The row was recognised by contract address (trusted) but built with the contract's symbol, which is the old name.
    const h = setup([
      info({
        id: "tk_pol",
        ref: "src/issued:polygon-ecosystem-token",
        symbol: "MATIC",
        name: "Matic Network",
        providerLogo: "zerion-matic.png",
        infoStale: true,
      }),
    ]);
    h.upstream.markets = [
      {
        ref: "src/issued:polygon-ecosystem-token",
        symbol: "POL",
        name: "POL (ex-MATIC)",
        logo: "pol.png",
      },
    ];

    expect(
      (await h.run(Effect.flatMap(TokenService, (t) => t.refreshStale(["tk_pol"])))).infos,
    ).toBe(1);
    const row = h.store.rows.get("tk_pol");
    expect(row?.symbol).toBe("POL"); // overwritten, not an empty-slot fill
    expect(row?.name).toBe("POL (ex-MATIC)");
    expect(row?.logo).toBe("pol.png");
    // The connector's spare logo stays: upstream has no right to overwrite it (second tier of the display fallback chain).
    expect(row?.providerLogo).toBe("zerion-matic.png");
  });

  it("upstream gave no logo this time: keeps the existing one, does not blank it", async () => {
    const h = setup([info({ id: "tk_1", symbol: "OLD", logo: "old.png", infoStale: true })]);
    h.upstream.markets = [{ ref: SRC_BTC, symbol: "BTC", name: "Bitcoin" }];

    await h.run(Effect.flatMap(TokenService, (t) => t.refreshStale(["tk_1"])));
    expect(h.store.rows.get("tk_1")).toMatchObject({ symbol: "BTC", logo: "old.png" });
  });

  it("upstream down: nothing written, no throw, the row keeps the connector's values", async () => {
    const h = setup([info({ id: "tk_1", symbol: "OLD", infoStale: true })]);
    h.upstream.fail = upstreamDown();

    expect((await h.run(Effect.flatMap(TokenService, (t) => t.refreshStale(["tk_1"])))).infos).toBe(
      0,
    );
    expect(h.store.rows.get("tk_1")).toMatchObject({ symbol: "OLD", infoStale: true });
  });

  it("upstream returns a ref that maps to no token: dropped, not written", async () => {
    const h = setup([info({ id: "tk_1", symbol: "OLD", infoStale: true })]);
    h.upstream.fetchTokens = () =>
      Effect.succeed([{ ref: "src/issued:somebody-else", symbol: "ELSE", name: "Else" }]);

    expect((await h.run(Effect.flatMap(TokenService, (t) => t.refreshStale(["tk_1"])))).infos).toBe(
      0,
    );
    expect(h.store.rows.get("tk_1")?.symbol).toBe("OLD");
  });
});

describe("edge cases", () => {
  it("upstream returns a ref that maps to no token: skipped, no stray row", async () => {
    const h = setup([info({ id: "tk_1" })]);
    // Upstream returned a ref we did not ask for (or one merged away).
    h.upstream.prices.set(SRC_BTC, { unitPrice: 60000, asOf: NOW });
    h.upstream.prices.set("src/issued:stranger", { unitPrice: 1, asOf: NOW });

    expect(
      (await h.run(Effect.flatMap(TokenService, (t) => t.refreshStale(["tk_1"])))).prices,
    ).toBe(1);
    expect([...h.prices.current.keys()]).toEqual(["tk_1"]);
  });

  it("price exists but the info row is gone (merge deleted it): enrichment yields no such row", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* h.prices.put([{ tokenId: "tk_gone", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
        const got = yield* tokens.enrich(["tk_1", "tk_gone"]);
        expect([...got.keys()]).toEqual(["tk_1"]);
      }),
    );
  });
});

describe("historical daily prices (by token_id)", () => {
  const day = (offset: number) => (TODAY + offset) * MS_PER_DAY;

  it("priceSeries reads the table only: missing past days are absent, no network at all", async () => {
    const h = setup([info({ id: "tk_1" })]);
    h.upstream.series = [{ atMs: day(-2), unitPrice: 200 }];
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* h.prices.putDaily("tk_1", [
          { dayBucket: TODAY - 3, unitPrice: 100 },
          { dayBucket: TODAY - 1, unitPrice: 300 },
        ]);
        expect(yield* tokens.priceSeries("tk_1", day(-3), day(-1))).toEqual([
          { atMs: day(-3), unitPrice: 100 },
          { atMs: day(-1), unitPrice: 300 },
        ]);
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  it("today's bucket reads the price table's current price (however old), no egress, no daily-table write; no current price means missing", async () => {
    const h = setup([info({ id: "tk_1" }), info({ id: "tk_2" })]);
    h.upstream.series = [{ atMs: NOW, unitPrice: 999 }];
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* h.prices.put([{ tokenId: "tk_1", unitPrice: 42, asOf: NOW }], PRICE_TTL_MS);
        expect(yield* tokens.priceSeries("tk_1", day(0), NOW)).toEqual([
          { atMs: day(0), unitPrice: 42 },
        ]);
        expect(yield* tokens.priceSeries("tk_2", day(0), NOW)).toEqual([]);
        expect(yield* h.prices.getDaily("tk_1", [TODAY])).toEqual(new Map());
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  it("fillDaily: missing past days are filled in one call and stored (not today); a rerun has zero egress", async () => {
    const h = setup([info({ id: "tk_1" })]);
    h.upstream.series = [
      { atMs: day(-3), unitPrice: 100 },
      { atMs: day(-2), unitPrice: 200 },
      { atMs: day(-1), unitPrice: 300 },
      { atMs: NOW, unitPrice: 999 },
    ];
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        expect(yield* tokens.fillDaily("tk_1", day(-3), 10)).toEqual({
          calls: 1,
          done: true,
          failed: false,
        });
        expect(yield* h.prices.getDaily("tk_1", [TODAY - 3, TODAY - 2, TODAY - 1, TODAY])).toEqual(
          new Map([
            [TODAY - 3, 100],
            [TODAY - 2, 200],
            [TODAY - 1, 300],
          ]),
        );
        expect(yield* tokens.fillDaily("tk_1", day(-3), 10)).toEqual({
          calls: 0,
          done: true,
          failed: false,
        });
        expect(h.upstream.calls).toHaveLength(1);
      }),
    );
  });

  it("fillDaily: days upstream has no points for are recorded as attempted, a rerun does not refetch them", async () => {
    const h = setup([info({ id: "tk_1" })]);
    h.upstream.series = [{ atMs: day(-1), unitPrice: 300 }]; // upstream has nothing for days -3 and -2
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* tokens.fillDaily("tk_1", day(-3), 10);
        yield* tokens.fillDaily("tk_1", day(-3), 10);
        expect(h.upstream.calls).toHaveLength(1);
      }),
    );
  });

  it("fillDaily: windows are cut by budget; three years is several windows, a spent budget stops and the next run resumes; next day only fills yesterday", async () => {
    const h = setup([info({ id: "tk_1" })]);
    const DAYS = 3 * 365;
    h.upstream.series = Array.from({ length: DAYS }, (_, i) => ({
      atMs: day(i - DAYS),
      unitPrice: i + 1,
    }));
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        const first = yield* tokens.fillDaily("tk_1", day(-DAYS), 2);
        expect(first).toEqual({ calls: 2, done: false, failed: false });
        const rest = yield* tokens.fillDaily("tk_1", day(-DAYS), 10);
        expect(rest.done).toBe(true);
        expect(first.calls + rest.calls).toBe(Math.ceil(DAYS / DAILY_FILL_DAYS_PER_CALL));
        const buckets = Array.from({ length: DAYS }, (_, i) => TODAY - DAYS + i);
        expect((yield* h.prices.getDaily("tk_1", buckets)).size).toBe(DAYS);

        // A day later: only "yesterday" (the old today) needs filling, one call.
        h.upstream.series.push({ atMs: day(0), unitPrice: 7 });
        yield* TestClock.adjust(Duration.days(1));
        const before = h.upstream.calls.length;
        expect(yield* tokens.fillDaily("tk_1", day(-DAYS), 10)).toEqual({
          calls: 1,
          done: true,
          failed: false,
        });
        expect(h.upstream.calls.length - before).toBe(1);
        expect(yield* h.prices.getDaily("tk_1", [TODAY])).toEqual(new Map([[TODAY, 7]]));
      }),
    );
  });

  it("fillDaily: upstream failure gives `failed`, the range does not advance and is retried next run; no throw", async () => {
    const h = setup([info({ id: "tk_1" })]);
    h.upstream.fail = upstreamDown();
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        expect(yield* tokens.fillDaily("tk_1", day(-2), 10)).toEqual({
          calls: 1,
          done: false,
          failed: true,
        });
        h.upstream.fail = undefined;
        h.upstream.series = [{ atMs: day(-2), unitPrice: 5 }];
        expect((yield* tokens.fillDaily("tk_1", day(-2), 10)).done).toBe(true);
        expect(yield* h.prices.getDaily("tk_1", [TODAY - 2])).toEqual(new Map([[TODAY - 2, 5]]));
      }),
    );
    expect(h.logs.some((l) => l.annotations.at === "tokens.fillDaily")).toBe(true);
  });

  it("fillDaily: the table already has the whole window (filled for another user): no egress, counted as attempted", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* h.prices.putDaily("tk_1", [
          { dayBucket: TODAY - 2, unitPrice: 1 },
          { dayBucket: TODAY - 1, unitPrice: 2 },
        ]);
        expect(yield* tokens.fillDaily("tk_1", day(-2), 10)).toEqual({
          calls: 0,
          done: true,
          failed: false,
        });
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  it("token upstream does not recognise / reversed range: empty, upstream untouched", async () => {
    const h = setup([info({ id: "unknown", ref: null }), info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        expect(yield* tokens.priceSeries("unknown", day(-2), day(-1))).toEqual([]);
        expect(yield* tokens.priceSeries("tk_1", day(-1), day(-2))).toEqual([]);
        expect(yield* tokens.fillDaily("unknown", day(-2), 10)).toEqual({
          calls: 0,
          done: true,
          failed: false,
        });
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  it("priceAt reads the price of that UTC day bucket; no data that day gives none", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* h.prices.putDaily("tk_1", [{ dayBucket: TODAY - 5, unitPrice: 42 }]);
        expect(yield* tokens.priceAt("tk_1", day(-5) + 3_600_000)).toEqual(Option.some(42));
        expect(yield* tokens.priceAt("tk_1", day(-6))).toEqual(Option.none());
      }),
    );
  });

  // Buckets are whole epoch days, independent of month / year boundaries: no special behaviour across a month end.
  // (Grouping by `getMonth()` would be off by one at month starts.)
  it("priceAt across a month / year boundary works as usual; buckets are cut by epoch day", async () => {
    const h = setup([info({ id: "tk_1" })]);
    // 2023-12-31T23:00Z and 2024-01-01T01:00Z: two adjacent days across the year.
    const lastDayOf2023 = Date.UTC(2023, 11, 31, 23, 0, 0);
    const firstDayOf2024 = Date.UTC(2024, 0, 1, 1, 0, 0);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* h.prices.putDaily("tk_1", [
          { dayBucket: dayBucketOf(lastDayOf2023), unitPrice: 100 },
          { dayBucket: dayBucketOf(firstDayOf2024), unitPrice: 200 },
        ]);

        expect(yield* tokens.priceAt("tk_1", lastDayOf2023)).toEqual(Option.some(100));
        expect(yield* tokens.priceAt("tk_1", firstDayOf2024)).toEqual(Option.some(200));
      }),
    );
    // The two bucket numbers are adjacent: no bucket gained or lost across the year.
    expect(dayBucketOf(firstDayOf2024) - dayBucketOf(lastDayOf2023)).toBe(1);
  });

  it("priceAt reads that day's bucket, never yesterday's price as today's", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* h.prices.putDaily("tk_1", [{ dayBucket: TODAY - 3, unitPrice: 7 }]);
        // Midnight exactly (bucket start) counts as that day.
        expect(yield* tokens.priceAt("tk_1", day(-3))).toEqual(Option.some(7));
        // Next midnight is already the next bucket: no data for that day.
        expect(yield* tokens.priceAt("tk_1", day(-2))).toEqual(Option.none());
      }),
    );
  });
});

describe("picker pricing (by ref, no row created)", () => {
  it("fetched by ref: no token row and no price cache entry added", async () => {
    const h = setup();
    h.upstream.prices.set(SRC_BTC, { unitPrice: 60000, change24h: 1.5, asOf: NOW });

    expect(await h.run(Effect.flatMap(TokenService, (t) => t.priceByRef(SRC_BTC)))).toEqual(
      Option.some({ unitPrice: 60000, change24h: 1.5, asOf: NOW }),
    );
    // The user only clicked in the dropdown and has not submitted: nothing should be stored.
    expect(h.store.rows.size).toBe(0);
    expect(h.prices.current.size).toBe(0);
  });

  it("upstream does not recognise the ref: none (the form lets the user fill it in)", async () => {
    const h = setup();
    expect(
      await h.run(Effect.flatMap(TokenService, (t) => t.priceByRef("src/issued:nope"))),
    ).toEqual(Option.none());
  });

  it("upstream down: none, no throw; a missing price must not interrupt picking", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    expect(await h.run(Effect.flatMap(TokenService, (t) => t.priceByRef(SRC_BTC)))).toEqual(
      Option.none(),
    );
  });
});

describe("picker batch price refresh (pricesByRefs, no row created)", () => {
  const SRC_ETH = "src/issued:ethereum";

  it("a batch of refs fetched live: no token rows and no price cache added", async () => {
    const h = setup();
    h.upstream.prices.set(SRC_BTC, { unitPrice: 60000, change24h: 1.5, asOf: NOW });
    h.upstream.prices.set(SRC_ETH, { unitPrice: 3000, change24h: -2, asOf: NOW });

    const got = await h.run(
      Effect.flatMap(TokenService, (t) => t.pricesByRefs([SRC_BTC, SRC_ETH])),
    );
    expect(got.get(SRC_BTC)).toEqual({ unitPrice: 60000, change24h: 1.5, asOf: NOW });
    expect(got.get(SRC_ETH)).toEqual({ unitPrice: 3000, change24h: -2, asOf: NOW });
    expect(h.store.rows.size).toBe(0);
    expect(h.prices.current.size).toBe(0);
  });

  it("empty input: empty Map, no network", async () => {
    const h = setup();
    const got = await h.run(Effect.flatMap(TokenService, (t) => t.pricesByRefs([])));
    expect(got.size).toBe(0);
    expect(h.upstream.calls).toEqual([]);
  });

  it("upstream down: empty Map, no throw; a failed refresh must not interrupt the dropdown", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    const got = await h.run(Effect.flatMap(TokenService, (t) => t.pricesByRefs([SRC_BTC])));
    expect(got.size).toBe(0);
  });
});

describe("showcase and candidates", () => {
  const markets = [
    {
      ref: SRC_BTC,
      symbol: "BTC",
      name: "Bitcoin",
      price: { unitPrice: 60000, marketCapRank: 1, asOf: NOW },
    },
    {
      ref: "src/issued:tether",
      symbol: "USDT",
      name: "Tether",
      price: { unitPrice: 1, marketCapRank: 3, asOf: NOW },
    },
  ];

  it("the leaderboard reads warm (warmed once via SWR); candidates are the same rows", async () => {
    const h = setup();
    h.upstream.markets = markets;
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        expect((yield* tokens.topTokens(1)).map((t) => t.ref)).toEqual([SRC_BTC]);
        expect(h.upstream.calls).toEqual(["fetchMarkets:1000"]);
        // The second read comes from the blob without warming: only one key in the cache.
        expect((yield* tokens.topTokens(2)).map((t) => t.ref)).toEqual([
          SRC_BTC,
          "src/issued:tether",
        ]);
        expect(h.upstream.calls).toHaveLength(1);
        expect([...h.cache.entries.keys()]).toEqual(["warm"]);
      }),
    );
  });

  it("asking for more than exists: returns all, no padding", async () => {
    const h = setup();
    h.upstream.markets = [markets[0]];
    const got = await h.run(Effect.flatMap(TokenService, (t) => t.topTokens(50)));
    expect(got.map((t) => t.ref)).toEqual([SRC_BTC]);
    expect(got.every((t) => t !== undefined)).toBe(true);
  });

  it("warm failure does not throw: returns empty so the caller degrades", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    expect(await h.run(Effect.flatMap(TokenService, (t) => t.topTokens(10)))).toEqual([]);
  });

  it("search always fetches upstream (results are user-independent)", async () => {
    const h = setup();
    h.upstream.searchResults = [{ ref: SRC_BTC, symbol: "BTC", name: "Bitcoin" }];
    expect(await h.run(Effect.flatMap(TokenService, (t) => t.search("bit")))).toHaveLength(1);
    expect(h.upstream.calls).toEqual(["searchTokens:bit"]);
  });

  // Search is the only method that surfaces upstream errors: it has no local stale value, and swallowing would look like "token not found".
  it('search failure: the error goes to the caller, not treated as "no results"', async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    const result = await h.run(Effect.result(Effect.flatMap(TokenService, (t) => t.search("bit"))));
    expect(result._tag).toBe("Failure");
  });
});

// Degradation must leave a trace: otherwise upstream rate-limiting overnight shows only as old prices to users.
describe("degradation leaves a trace", () => {
  it("upstream down: one warning with tag / pathname / status, and no query", async () => {
    const h = setup([info({ id: "tk_1" })]);
    h.upstream.fail = upstreamDown();
    await h.run(Effect.flatMap(TokenService, (t) => t.refreshStale(["tk_1"])));

    const warn = h.logs.find((l) => l.level === "WARN");
    expect(warn?.message).toContain("upstream fetch failed");
    expect(warn?.annotations).toMatchObject({
      at: "tokens.refreshStale.prices",
      error: "UpstreamUnavailableError",
      where: "/fake",
      status: 503,
    });
    // `where` is a pathname, so no key / signature / address can appear.
    expect(JSON.stringify(warn?.annotations)).not.toContain("?");
  });
});
