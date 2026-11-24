import type { AssetPlatform, MarketCoin } from "@folio/coingecko-client";
import { TokenUpstream } from "@folio/upstream-basic/ports";
import { runClient } from "@folio/upstreams/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
// The page cap is not exported; take it from the constants module to test the page boundary.
import { IDS_PER_REQUEST, MARKETS_PER_PAGE, UPSTREAM_ID } from "../src/constants";
import { makeUpstreamEffects } from "../src/upstream";
import { coinGeckoUpstreamLayers } from "../src/upstreams";
import assetPlatforms from "./fixtures/asset-platforms.json" with { type: "json" };
import { type Call, routed, run, type Stub, stubbing } from "./harness";

// Chains parse.ts / ref-index.ts into the real upstream: pagination and chain-id translation.
// Stubs the `HttpClient` service so the endpoint and params the adapter asked for are pinned.

const PLATFORMS = assetPlatforms as AssetPlatform[];

// Fresh implementation per case.
const impl = () => makeUpstreamEffects();

const marketRow = (id: string, rank: number): MarketCoin =>
  ({
    id,
    symbol: id.slice(0, 4),
    name: id,
    current_price: 1,
    market_cap_rank: rank,
  }) as MarketCoin;

// Page n: coin ids are offset per page; otherwise both pages return the same coins and dedupe would look no different from no dedupe.
const page = (count: number, pageNo = 1) =>
  Array.from({ length: count }, (_, i) => {
    const at = (pageNo - 1) * MARKETS_PER_PAGE + i;
    return marketRow(`coin-${at}`, at + 1);
  }) as MarketCoin[];

describe("port layer", () => {
  // The assembly point only imports this layer, so it must be exercised once: `R = never` and `id` is this adapter's constant
  // (used by the service as the ref namer). The layer brings its own real HTTP client, which reads the global `fetch` per call,
  // so the global is spied on instead of providing a fake client.
  it("methods obtained via the layer still reach the network (wiring intact)", async () => {
    const hits: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      hits.push(String(input instanceof Request ? input.url : input));
      return Response.json([marketRow("bitcoin", 1)]);
    });
    const stub = routed({});
    const rows = await runClient(
      stub.http,
      Effect.flatMap(TokenUpstream, (u) => u.fetchMarkets({ topN: 1 })).pipe(
        Effect.provide(coinGeckoUpstreamLayers().token),
      ),
      "none",
    ).finally(() => vi.restoreAllMocks());
    expect(rows.map((r) => r.ref)).toEqual(["coingecko/issued:bitcoin"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("/coins/markets");
  });
});

describe("fetchMarkets pagination", () => {
  it("topN across pages: fetches page by page, increasing page numbers, trims to topN", async () => {
    let n = 0;
    const stub = routed({ "/coins/markets": () => page(MARKETS_PER_PAGE, ++n) });
    const rows = await run(stub, impl().fetchMarkets({ topN: MARKETS_PER_PAGE + 10 }));

    expect(stub.calls.map((c) => c.query.get("page"))).toEqual(["1", "2"]);
    expect(stub.calls[0].query.get("per_page")).toBe(String(MARKETS_PER_PAGE));
    // Two pages of 250 rows, but only 260 wanted: the excess is trimmed.
    expect(rows).toHaveLength(MARKETS_PER_PAGE + 10);
  });

  it("fits in one page: single request", async () => {
    const stub = routed({ "/coins/markets": () => page(10) });
    expect(await run(stub, impl().fetchMarkets({ topN: 10 }))).toHaveLength(10);
    expect(stub.calls).toHaveLength(1);
  });

  // Fewer coins than requested: a short page means no next page; asking again only wastes a 429 chance.
  it("upstream returns less than a page: stops early, no next page", async () => {
    const stub = routed({ "/coins/markets": () => page(3) });
    const rows = await run(stub, impl().fetchMarkets({ topN: MARKETS_PER_PAGE * 3 }));

    expect(stub.calls).toHaveLength(1);
    expect(rows).toHaveLength(3);
  });

  it("topN below one page still asks once (never zero pages)", async () => {
    const stub = routed({ "/coins/markets": () => page(1) });
    await run(stub, impl().fetchMarkets({ topN: 0 }));
    expect(stub.calls).toHaveLength(1);
  });
});

// Pages come from different snapshots, so a coin can repeat across pages; pages must be deduped when stitched.
describe("fetchMarkets duplicates across pages (pages from different snapshots)", () => {
  // The last coin of page 1 reappears on page 2.
  const overlapping = (pageNo: number): MarketCoin[] => {
    const rows = page(MARKETS_PER_PAGE, pageNo);
    if (pageNo === 2) rows[0] = marketRow("coin-249", 250); // same coin as end of page 1
    return rows;
  };

  const twoPages = () => {
    let n = 0;
    return routed({ "/coins/markets": () => overlapping(++n) });
  };

  it("same coin on two pages: kept once", async () => {
    const rows = await run(twoPages(), impl().fetchMarkets({ topN: MARKETS_PER_PAGE * 2 }));

    const refs = rows.map((r) => r.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("keeps the first occurrence: it ranks higher", async () => {
    const rows = await run(twoPages(), impl().fetchMarkets({ topN: MARKETS_PER_PAGE * 2 }));

    const dup = rows.filter((r) => r.ref === `${UPSTREAM_ID}/issued:coin-249`);
    expect(dup).toHaveLength(1);
    // Page 1 gives rank 250; page 2's entry is also 250 but sits on page 1, so the earlier one is kept.
    expect(rows.indexOf(dup[0])).toBe(MARKETS_PER_PAGE - 1);
  });

  // Dedupe leaves fewer than topN; topN means how deep to fetch, not a guaranteed count.
  it("fewer than topN after dedupe stays short, no extra page to refill", async () => {
    const stub = twoPages();
    const rows = await run(stub, impl().fetchMarkets({ topN: MARKETS_PER_PAGE * 2 }));

    expect(rows).toHaveLength(MARKETS_PER_PAGE * 2 - 1);
    expect(stub.calls).toHaveLength(2); // no page 3
  });
});

describe("refs not named by this upstream: no request", () => {
  it("prices: no coin id resolvable means no request", async () => {
    const stub = routed({ "/simple/price": {} });
    const got = await run(
      stub,
      impl().fetchPrices(["evm:1/contract:0xa0b8", "binance/issued:USDC"]),
    );
    expect(got.size).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("prices: mixed refs send only those that resolve", async () => {
    const stub = routed({ "/simple/price": { "usd-coin": { usd: 1, last_updated_at: 1700 } } });
    const got = await run(
      stub,
      impl().fetchPrices(["evm:1/contract:0xa0b8", "coingecko/issued:usd-coin"]),
    );

    expect(stub.calls[0].query.get("ids")).toBe("usd-coin");
    expect(got.get("coingecko/issued:usd-coin")?.unitPrice).toBe(1);
  });

  it("history: on-chain ref yields empty, no request", async () => {
    const stub = routed({ "/market_chart/range": { prices: [] } });
    expect(await run(stub, impl().fetchPriceSeries("evm:1/contract:0xa0b8", 0, 1))).toEqual([]);
    expect(stub.calls).toHaveLength(0);
  });

  it("history: own-named ref sends range in seconds, ms rounded outward", async () => {
    const stub = routed({ "/market_chart/range": { prices: [[1700000000000, 1]] } });
    const got = await run(stub, impl().fetchPriceSeries("coingecko/issued:usd-coin", 1500, 2500));

    expect(stub.calls[0].path).toContain("/coins/usd-coin/market_chart/range");
    expect(stub.calls[0].query.get("from")).toBe("1"); // floor(1500/1000)
    expect(stub.calls[0].query.get("to")).toBe("3"); // ceil(2500/1000)
    expect(stub.calls[0].query.get("vs_currency")).toBe("usd"); // defaults to USD
    expect(got).toHaveLength(1);
  });

  // Fiat history derivation fetches BTC's price in a fiat via this same path; only vs_currency changes.
  it("history: vsCurrency is switchable; EUR is lowercased to eur upstream", async () => {
    const stub = routed({ "/market_chart/range": { prices: [[1700000000000, 92000]] } });
    await run(stub, impl().fetchPriceSeries("coingecko/issued:bitcoin", 1500, 2500, "EUR"));

    expect(stub.calls[0].path).toContain("/coins/bitcoin/market_chart/range");
    expect(stub.calls[0].query.get("vs_currency")).toBe("eur");
  });
});

// Must use `/coins/markets?ids=`, not `/simple/price`, which lacks the name/symbol/image this method exists to fetch.
describe("fetchTokens full-row lookup by id", () => {
  it("hits /coins/markets with ids named, no pagination", async () => {
    const stub = routed({
      "/coins/markets": [marketRow("usd-coin", 6), marketRow("ethereum", 2)],
    });
    const got = await run(
      stub,
      impl().fetchTokens(["coingecko/issued:usd-coin", "coingecko/issued:ethereum"]),
    );

    expect(stub.calls).toHaveLength(1); // one request, no page=2
    expect(stub.calls[0].path).toContain("/coins/markets");
    expect(stub.calls[0].query.get("ids")).toBe("usd-coin,ethereum");
    expect(stub.calls[0].query.get("price_change_percentage")).toBe("24h");
    expect(got.map((t) => t.ref)).toEqual([
      "coingecko/issued:usd-coin",
      "coingecko/issued:ethereum",
    ]);
    expect(got[0].name).toBe("usd-coin"); // name and image came back (the difference from fetchPrices)
  });

  it("no resolvable coin id: no request", async () => {
    const stub = routed({ "/coins/markets": [] });
    expect(
      await run(stub, impl().fetchTokens(["evm:1/contract:0xa0b8", "binance/issued:USDC"])),
    ).toEqual([]);
    expect(stub.calls).toHaveLength(0);
  });

  it("ids upstream does not list are absent from the result (not an error)", async () => {
    const stub = routed({ "/coins/markets": [marketRow("usd-coin", 6)] });
    const got = await run(
      stub,
      impl().fetchTokens(["coingecko/issued:usd-coin", "coingecko/issued:never-listed"]),
    );
    expect(got.map((t) => t.ref)).toEqual(["coingecko/issued:usd-coin"]);
  });
});

// Big id lists must be chunked, fetched per batch and merged; otherwise the URL exceeds the limit and CoinGecko answers 414.
describe("large id batches are chunked (avoids 414)", () => {
  const refsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => `${UPSTREAM_ID}/issued:coin-${i}`);

  // Responds dynamically from the ids in the query: each batch echoes its ids, so all n only appear if every batch merged.
  const echoingIds = (build: (ids: string[]) => unknown): Stub =>
    stubbing((call) => build((call.query.get("ids") ?? "").split(",").filter(Boolean)));

  const eachBatchWithinLimit = (calls: readonly Call[]) => {
    for (const c of calls) {
      expect((c.query.get("ids") ?? "").split(",").length).toBeLessThanOrEqual(IDS_PER_REQUEST);
    }
  };

  it("prices: ids over the batch cap split into batches, each <= cap, results merged", async () => {
    const n = IDS_PER_REQUEST * 2 + 5; // 3 batches: full, full, remainder 5
    const stub = echoingIds((ids) =>
      Object.fromEntries(ids.map((id) => [id, { usd: 1, last_updated_at: 1700 }])),
    );

    const got = await run(stub, impl().fetchPrices(refsOf(n)));

    expect(stub.calls).toHaveLength(3);
    eachBatchWithinLimit(stub.calls);
    expect(got.size).toBe(n); // every batch's prices reached the merged Map
  });

  it("full rows: chunked the same way, row count is the sum of batches", async () => {
    const n = IDS_PER_REQUEST + 1; // 2 batches
    const stub = echoingIds((ids) => ids.map((id, i) => marketRow(id, i + 1)));

    const got = await run(stub, impl().fetchTokens(refsOf(n)));

    expect(stub.calls).toHaveLength(2);
    eachBatchWithinLimit(stub.calls);
    expect(got).toHaveLength(n);
  });

  it("exactly one batch (= cap): single request, no extra split", async () => {
    const stub = routed({ "/simple/price": { "coin-0": { usd: 1, last_updated_at: 1700 } } });
    await run(stub, impl().fetchPrices(refsOf(IDS_PER_REQUEST)));
    expect(stub.calls).toHaveLength(1);
  });
});

describe("search and global mapping", () => {
  it("search passes the query through", async () => {
    const stub = routed({ "/search": { coins: [{ id: "usd-coin", symbol: "usdc" }] } });
    const got = await run(stub, impl().searchTokens("usdc"));

    expect(stub.calls[0].query.get("query")).toBe("usdc");
    expect(got[0]?.ref).toBe(`${UPSTREAM_ID}/issued:usd-coin`);
  });

  it("global mapping fetches both endpoints concurrently (catalogue + platform table)", async () => {
    const stub = routed({
      "/coins/list": [{ id: "usd-coin", symbol: "usdc", platforms: { ethereum: "0xA0B8" } }],
      "/asset_platforms": PLATFORMS,
    });
    const got = await run(stub, impl().fetchRefIndex());

    expect(stub.calls.map((c) => c.path.split("/api/v3")[1]).sort()).toEqual([
      "/asset_platforms",
      "/coins/list",
    ]);
    expect(
      stub.calls.find((c) => c.path.includes("/coins/list"))?.query.get("include_platform"),
    ).toBe("true");
    expect(got.rows).toEqual([
      { chainRef: "evm:1/contract:0xa0b8", upstreamRef: `${UPSTREAM_ID}/issued:usd-coin` },
    ]);
  });
});
