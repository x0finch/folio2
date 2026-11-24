import { FxUpstream } from "@folio/upstream-basic/ports";
import { runClient } from "@folio/upstreams/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fetchRatesEffect } from "../src/fx";
import { coinGeckoUpstreamLayers } from "../src/upstreams";
import { failing, run, stubbing } from "./harness";

// Upstream is quoted against BTC: usdPerUnit(X) = usd.value / X.value.
const RATES = {
  rates: {
    btc: { value: 1, type: "crypto" },
    usd: { value: 100000, type: "fiat" }, // 1 BTC = 100000 USD
    eur: { value: 92000, type: "fiat" }, // 1 EUR = 100000/92000 USD
    eth: { value: 40, type: "crypto" }, // 1 ETH = 2500 USD
  },
};

describe("fetchRates", () => {
  it("derives usdPerUnit: USD=1, EUR=usd/eur, ETH=usd/eth, BTC=usd/btc", async () => {
    const rates = await run(
      stubbing(() => RATES),
      fetchRatesEffect,
    );

    expect(rates.get("USD")).toBe(1);
    expect(rates.get("EUR")).toBeCloseTo(100000 / 92000, 6);
    expect(rates.get("ETH")).toBe(2500);
    expect(rates.get("BTC")).toBe(100000);
  });

  it("omits currencies upstream does not list (not an error)", async () => {
    const rates = await run(
      stubbing(() => RATES),
      fetchRatesEffect,
    );
    expect(rates.has("KRW")).toBe(false); // absent from this response
  });

  it("returns only whitelisted currencies; extras from upstream are dropped", async () => {
    const rates = await run(
      stubbing(() => ({ rates: { ...RATES.rates, xag: { value: 3000, type: "commodity" } } })),
      fetchRatesEffect,
    );
    expect(rates.has("XAG")).toBe(false);
  });

  it("fails when the base (usd) is missing: a broken response, not a missing currency", async () => {
    // A parse error, so not retryable: refetching yields the same bad shape.
    const err = await failing(
      stubbing(() => ({ rates: { eur: { value: 1 } } })),
      fetchRatesEffect,
    );
    expect(err._tag).toBe("UpstreamParseError");
    expect(err.cause).toBe("missing/invalid usd rate");
  });
});

// Base of the BTC-derived fiat history; history itself goes through PriceUpstream.fetchPriceSeries.
describe("btcRef", () => {
  it("btcRef = coingecko/issued:bitcoin, same key as the token side's BTC history (reusable)", async () => {
    const ref = await runClient(
      stubbing(() => ({})).http,
      Effect.map(FxUpstream, (u) => u.btcRef).pipe(Effect.provide(coinGeckoUpstreamLayers().fx)),
      "none",
    );
    expect(ref).toBe("coingecko/issued:bitcoin");
  });
});
