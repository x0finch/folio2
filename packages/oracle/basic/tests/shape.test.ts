import { describe, expect, it } from "vitest";
import type { TokenPriceHistoryStore, TokenStore } from "../src/store";
import type { TokenSource } from "../src/token";
import { cgkRef } from "../src/vendor";

// Stubs prove the (reshaped) interfaces are implementable — `satisfies` is the compile-time proof.
// `: Token{Source,Store}` annotations are the compile-time proof the interfaces are implementable.
const source: TokenSource = {
  vendor: "coingecko",
  fetchMarkets: async () => [],
  fetchByContract: async () => null,
  fetchPrices: async () => new Map(),
  fetchPriceSeries: async () => [],
  searchTokens: async () => [],
};

const priceHistory: TokenPriceHistoryStore = {
  getDailyPrices: async () => new Map(),
  putDailyPrices: async () => {},
};

const store: TokenStore = {
  getCandidates: async () => [],
  putWarm: async () => {},
  warmAsOf: async () => null,
  listTopTokens: async () => [],
  getByTokenRef: async () => new Map(),
  ensureTokenRef: async () => {},
  markCgkChecked: async () => {},
  linkTokenRefToCgk: async () => {},
  getByRefs: async () => new Map(),
  getById: async () => undefined,
  putPrices: async () => {},
};

describe("interface shapes", () => {
  it("TokenSource is implementable", async () => {
    expect(await source.fetchMarkets({ topN: 1 })).toEqual([]);
  });
  it("TokenStore is implementable", async () => {
    expect((await store.getByTokenRef(["eip155:1/erc20:0x0"])).size).toBe(0);
  });
  it("TokenPriceHistoryStore is implementable", async () => {
    const ref = cgkRef("bitcoin");
    expect((await priceHistory.getDailyPrices(ref, [1])).size).toBe(0);
  });
});
