import type { CoinId, TokenRef } from "@folio/tokens";
import { describe, expect, it } from "vitest";
import {
  buildIndex,
  parseAssetPlatforms,
  parseCoinsList,
  parseMarkets,
  parseRetryAfter,
  parseSimplePrice,
} from "../src/parse";
import platformsJson from "./fixtures/asset_platforms.json";
import listJson from "./fixtures/coins_list.json";
import marketsJson from "./fixtures/coins_markets_p1.json";
import simpleJson from "./fixtures/simple_price.json";

const cg = (id: string): TokenRef => ({ source: "coingecko", coinId: id as CoinId });

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

describe("parseCoinsList", () => {
  it("builds byContract (platform:addrLower) + bySymbol (normalized, rank-free)", () => {
    const { byContract, bySymbol } = parseCoinsList(listJson);
    expect(byContract).toEqual(
      new Map([
        ["ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", cg("usd-coin")],
        ["polygon-pos:0x2791bca1f2de4661ed88a30c99a7a9449aa84174", cg("usd-coin")],
        ["solana:fake1111111111111111111111111111111111111111", cg("usdc-fake")],
      ]),
    );
    expect(bySymbol).toEqual(
      new Map([
        ["BTC", [{ ref: cg("bitcoin") }]],
        ["USDC", [{ ref: cg("usd-coin") }, { ref: cg("usdc-fake") }]],
      ]),
    );
  });
});

describe("buildIndex", () => {
  it("combines platforms + list + asOf", () => {
    const index = buildIndex(platformsJson, listJson, 12345);
    expect(index.asOf).toBe(12345);
    expect(index.platforms.get("1")).toBe("ethereum");
    expect(index.byContract.size).toBe(3);
    expect(index.bySymbol.get("USDC")).toHaveLength(2);
  });
});

describe("parseMarkets", () => {
  it("splits each row into {info, price}; skips rows without a price", () => {
    const asOf = Date.parse("2026-06-29T00:00:00.000Z");
    expect(parseMarkets(marketsJson, "usd")).toEqual([
      {
        info: {
          ref: cg("bitcoin"),
          symbol: "btc",
          name: "Bitcoin",
          logo: "https://assets.coingecko.com/coins/images/1/large/bitcoin.png",
        },
        price: {
          ref: cg("bitcoin"),
          unitPrice: 65000,
          change24h: 1.5,
          marketCapRank: 1,
          vs: "usd",
          asOf,
        },
      },
      {
        info: {
          ref: cg("ethereum"),
          symbol: "eth",
          name: "Ethereum",
          logo: "https://assets.coingecko.com/coins/images/279/large/ethereum.png",
        },
        price: {
          ref: cg("ethereum"),
          unitPrice: 3500,
          change24h: -2.1,
          marketCapRank: 2,
          vs: "usd",
          asOf,
        },
      },
    ]);
  });
});

describe("parseSimplePrice", () => {
  it("maps each id → TokenPrice keyed by refKey (last_updated_at → ms)", () => {
    expect(parseSimplePrice(simpleJson, "usd")).toEqual(
      new Map([
        [
          "coingecko:bitcoin",
          { ref: cg("bitcoin"), unitPrice: 65000, change24h: 1.5, vs: "usd", asOf: 1782000000000 },
        ],
        [
          "coingecko:ethereum",
          { ref: cg("ethereum"), unitPrice: 3500, change24h: -2.1, vs: "usd", asOf: 1782000000000 },
        ],
      ]),
    );
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
