import { DEFAULT_TOP_N, PRICE_TTL_MS, type UpstreamToken } from "@folio/oracle-basic";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { CandidateSource } from "../src/tokens/candidates";
import { harness, upstreamDown } from "./fakes";

// The candidate source on mint's symbol tier sits on the write path (sync, manual entry form), so it tolerates staleness
// unlike the showcase: use what exists however old. These cases pin that it never goes to the network for freshness.

const coin = (id: string, symbol: string, rank?: number): UpstreamToken => ({
  ref: `src/issued:${id}`,
  symbol,
  name: symbol,
  price: { unitPrice: 1, marketCapRank: rank, asOf: 0 },
});

function setup(markets: UpstreamToken[] = []) {
  const h = harness();
  h.upstream.markets = markets;
  return h;
}

const bySymbol = (symbol: string) => Effect.flatMap(CandidateSource, (c) => c.bySymbol(symbol));

describe("candidates by symbol", () => {
  it("returns all same-named tokens with ranks (the judge decides whom to trust)", async () => {
    const h = setup([coin("usd-coin", "USDC", 6), coin("fake-usdc", "usdc", 4200)]);
    expect(await h.run(bySymbol("usdc"))).toEqual([
      { ref: "src/issued:usd-coin", marketCapRank: 6 },
      { ref: "src/issued:fake-usdc", marketCapRank: 4200 },
    ]);
  });

  it("normalised the same way: case and whitespace do not affect the hit", async () => {
    const h = setup([coin("bitcoin", "btc", 1)]);
    expect(await h.run(bySymbol("  BTC "))).toEqual([
      { ref: "src/issued:bitcoin", marketCapRank: 1 },
    ]);
  });

  it("no same-named token: empty, no error", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    expect(await h.run(bySymbol("NOPE"))).toEqual([]);
  });
});

describe("no egress for freshness: the one difference from the showcase", () => {
  it("an old catalogue is never refetched: after the first call, a year later is still zero requests", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* bySymbol("BTC"); // cold: fetch once

        for (const skip of [PRICE_TTL_MS + 1, 24 * 60 * 60 * 1000, 365 * 24 * 60 * 60 * 1000]) {
          yield* TestClock.adjust(Duration.millis(skip));
          expect(yield* bySymbol("BTC")).toHaveLength(1);
        }
      }),
    );
    expect(h.upstream.calls).toEqual([`fetchMarkets:${DEFAULT_TOP_N}`]); // always just that one
  });

  it("many symbol lookups in one mint round: still only the cold-start request", async () => {
    const h = setup([coin("bitcoin", "BTC", 1), coin("tether", "USDT", 3)]);
    await h.run(
      Effect.forEach(["BTC", "USDT", "NOPE", "BTC", "USDT"], bySymbol, { discard: true }),
    );
    expect(h.upstream.calls).toHaveLength(1);
  });
});

describe("cold start", () => {
  it("no cache at all: fetch once (unavoidable: empty candidates mean symbol-matched tokens are all unrecognised)", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    expect(await h.run(bySymbol("BTC"))).toHaveLength(1);
    expect(h.upstream.calls).toHaveLength(1);
  });

  it("rate-limited on cold start: empty candidates, no throw (unrecognised beats crashing the sync)", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    expect(await h.run(bySymbol("BTC"))).toEqual([]);
  });

  it("upstream recovers later: next call fills in (an empty blob is not cached)", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    await h.run(bySymbol("BTC"));

    h.upstream.fail = undefined;
    h.upstream.markets = [coin("bitcoin", "BTC", 1)];
    expect(await h.run(bySymbol("BTC"))).toHaveLength(1);
  });
});
