import type { CgkCoinId, TokenRef } from "@folio/tokens-basic";
import { describe, expect, it } from "vitest";
import {
  parseAssetPlatforms,
  parseContract,
  parseMarkets,
  parseRetryAfter,
  parseSearch,
  parseSimplePrice,
} from "../src/parse";
import platformsJson from "./fixtures/asset_platforms.json";
import contractJson from "./fixtures/coin_contract.json";
import marketsJson from "./fixtures/coins_markets_p1.json";
import searchJson from "./fixtures/search.json";
import simpleJson from "./fixtures/simple_price.json";

const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as CgkCoinId });

describe("parseAssetPlatforms", () => {
  it("maps slug + EVM chainId (both keys) → platform slug; non-EVM slug only", () => {
    expect(parseAssetPlatforms(platformsJson)).toEqual(
      new Map([
        ["ethereum", "ethereum"],
        ["1", "ethereum"],
        ["polygon-pos", "polygon-pos"],
        ["137", "polygon-pos"],
        ["solana", "solana"],
      ]),
    );
  });
  it("throws PARSE_ERROR on non-array", () => {
    expect(() => parseAssetPlatforms({})).toThrowError(/expected array/);
  });
});

describe("parseMarkets", () => {
  it("splits each row into {info, price}; skips rows without a price", () => {
    const asOf = Date.parse("2026-06-29T00:00:00.000Z");
    expect(parseMarkets(marketsJson)).toEqual([
      {
        info: {
          ref: cg("bitcoin"),
          symbol: "btc",
          name: "Bitcoin",
          logo: "https://assets.coingecko.com/coins/images/1/large/bitcoin.png",
        },
        price: { ref: cg("bitcoin"), unitPrice: 65000, change24h: 1.5, marketCapRank: 1, asOf },
      },
      {
        info: {
          ref: cg("ethereum"),
          symbol: "eth",
          name: "Ethereum",
          logo: "https://assets.coingecko.com/coins/images/279/large/ethereum.png",
        },
        price: { ref: cg("ethereum"), unitPrice: 3500, change24h: -2.1, marketCapRank: 2, asOf },
      },
    ]);
  });
});

describe("parseSimplePrice", () => {
  it("maps each id → TokenPrice keyed by refKey (last_updated_at → ms)", () => {
    expect(parseSimplePrice(simpleJson)).toEqual(
      new Map([
        [
          "coingecko:bitcoin",
          { ref: cg("bitcoin"), unitPrice: 65000, change24h: 1.5, asOf: 1782000000000 },
        ],
        [
          "coingecko:ethereum",
          { ref: cg("ethereum"), unitPrice: 3500, change24h: -2.1, asOf: 1782000000000 },
        ],
      ]),
    );
  });
});

describe("parseContract", () => {
  it("maps per-contract response → {ref, info(logo from image.large), price(usd under market_data)}", () => {
    expect(parseContract(contractJson)).toEqual({
      ref: cg("usd-coin"),
      info: {
        ref: cg("usd-coin"),
        symbol: "usdc",
        name: "USDC",
        logo: "https://coin-images.coingecko.com/coins/images/6319/large/usdc.png",
      },
      price: {
        ref: cg("usd-coin"),
        unitPrice: 1.001,
        change24h: 0.05,
        marketCapRank: 6,
        asOf: Date.parse("2026-06-29T00:00:00.000Z"),
      },
    });
  });
  it("returns null when no id / no price", () => {
    expect(parseContract({ id: "x" })).toBeNull();
    expect(parseContract({ market_data: { current_price: { usd: 1 } } })).toBeNull();
  });
});

describe("parseSearch", () => {
  it("coins[] → TokenInfo[] sorted by market_cap_rank asc (unranked last), logo from large", () => {
    // fixture raw order is WBTC(15), SBF(null), BTC(1) — output must be rank-sorted.
    expect(parseSearch(searchJson)).toEqual([
      {
        ref: cg("bitcoin"),
        symbol: "BTC",
        name: "Bitcoin",
        logo: "https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png",
      },
      {
        ref: cg("wrapped-bitcoin"),
        symbol: "WBTC",
        name: "Wrapped Bitcoin",
        logo: "https://coin-images.coingecko.com/coins/images/7598/large/wrapped_bitcoin_wbtc.png",
      },
      {
        ref: cg("some-bitcoin-fork"),
        symbol: "SBF",
        name: "Some Bitcoin Fork",
        logo: "https://coin-images.coingecko.com/coins/images/9999/large/sbf.png",
      },
    ]);
  });
  it("throws PARSE_ERROR when no coins array", () => {
    expect(() => parseSearch({})).toThrowError(/coins/);
  });
});

describe("parseRetryAfter", () => {
  it("numeric seconds → ms", () => {
    expect(parseRetryAfter("30")).toBe(30000);
  });
  it("HTTP-date → ms delta from now", () => {
    const at = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", at - 5000)).toBe(5000);
  });
  it("null / garbage → undefined", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });
});
