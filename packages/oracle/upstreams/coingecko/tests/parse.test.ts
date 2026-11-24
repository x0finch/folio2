import { describe, expect, it } from "vitest";
import {
  cgkRef,
  coinIdOf,
  parseMarkets,
  parsePriceSeries,
  parseSearch,
  parseSimplePrice,
  UPSTREAM_ID,
} from "../src";
import simplePrice from "./fixtures/simple-price.json";

describe("ref and coin id both ways", () => {
  it("build: coin id normalised to lowercase kebab, namer is always this adapter's id", () => {
    expect(cgkRef("USD-Coin")).toBe(`${UPSTREAM_ID}/issued:usd-coin`);
  });

  it("parse: own-namer ref gives coin id; foreign / on-chain refs give undefined", () => {
    expect(coinIdOf(`${UPSTREAM_ID}/issued:bitcoin`)).toBe("bitcoin");
    expect(coinIdOf("evm:1/contract:0xa0b8")).toBeUndefined(); // on-chain address
    expect(coinIdOf("coinmarketcap/issued:1")).toBeUndefined(); // foreign issued id
    // Matching the namer is not enough: the local name must be an `issued:` id, not a contract address.
    expect(coinIdOf(`${UPSTREAM_ID}/contract:0xa0b8`)).toBeUndefined();
    expect(coinIdOf(`${UPSTREAM_ID}/custom:MYCOIN`)).toBeUndefined();
  });
});

describe("parseMarkets", () => {
  it("one row gives metadata + USD price; skips rows without id / symbol", () => {
    const rows = parseMarkets([
      {
        id: "bitcoin",
        symbol: "btc",
        name: "Bitcoin",
        image: "b.png",
        current_price: 60000,
        market_cap_rank: 1,
        price_change_percentage_24h: 1.5,
        last_updated: "2023-11-14T22:13:20.000Z",
      },
      { symbol: "no-id" },
      { id: "no-symbol" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ref: `${UPSTREAM_ID}/issued:bitcoin`,
      symbol: "btc",
      name: "Bitcoin",
      logo: "b.png",
    });
    expect(rows[0]?.price).toMatchObject({ unitPrice: 60000, marketCapRank: 1, change24h: 1.5 });
    expect(rows[0]?.price?.asOf).toBe(Date.parse("2023-11-14T22:13:20.000Z"));
  });
});

describe("parseSearch / parseSimplePrice / parsePriceSeries", () => {
  it("search: falls back to symbol when name is missing; prefers large image", () => {
    const out = parseSearch({ coins: [{ id: "bitcoin", symbol: "btc", large: "l.png" }] });
    expect(out).toEqual([
      { ref: `${UPSTREAM_ID}/issued:bitcoin`, symbol: "btc", name: "btc", logo: "l.png" },
    ]);
  });

  it("search: carries market_cap_rank (disambiguation badge); omitted when absent", () => {
    const out = parseSearch({
      coins: [
        { id: "usd-coin", symbol: "usdc", name: "USD Coin", large: "l.png", market_cap_rank: 6 },
        { id: "bridged-usdc", symbol: "usdc", name: "Bridged USDC" }, // no rank
      ],
    });
    expect(out[0]?.marketCapRank).toBe(6);
    expect(out[1]?.marketCapRank).toBeUndefined();
  });

  // Recorded real response: the timestamp field is `last_updated_at` without the `usd_` prefix (only 24h change has it).
  it("simple/price: indexed by ref, with 24h change; timestamp from upstream last_updated_at (seconds to ms)", () => {
    const out = parseSimplePrice(simplePrice.response, 999);
    const btc = simplePrice.response.bitcoin;
    expect(out.get(`${UPSTREAM_ID}/issued:bitcoin`)).toEqual({
      unitPrice: btc.usd,
      change24h: btc.usd_24h_change,
      asOf: btc.last_updated_at * 1000,
    });
    expect(out.size).toBe(2);
  });

  it("simple/price: skips entries without usd; missing timestamp falls back", () => {
    const out = parseSimplePrice({ broken: { eur: 1 }, plain: { usd: 2 } }, 999);
    expect(out.has(`${UPSTREAM_ID}/issued:broken`)).toBe(false);
    expect(out.get(`${UPSTREAM_ID}/issued:plain`)?.asOf).toBe(999);
  });

  it("price series: drops non-numbers, sorts ascending by time", () => {
    expect(
      parsePriceSeries([
        [3, 30],
        [1, 10],
        [Number.NaN, 20],
      ]),
    ).toEqual([
      { atMs: 1, unitPrice: 10 },
      { atMs: 3, unitPrice: 30 },
    ]);
  });
});
