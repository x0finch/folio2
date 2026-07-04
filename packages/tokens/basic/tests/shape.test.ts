import { describe, expect, it } from "vitest";
import type { TokenProvider } from "../src/provider";
import type { TokenStore } from "../src/store";

// Stubs prove the (reshaped) interfaces are implementable — `satisfies` is the compile-time proof.
// `: Token{Source,Store}` annotations are the compile-time proof the interfaces are implementable.
const source: TokenProvider = {
  source: "coingecko",
  fetchMarkets: async () => [],
  fetchByContract: async () => null,
  fetchPrices: async () => new Map(),
  searchTokens: async () => [],
};

const store: TokenStore = {
  getCandidates: async () => [],
  putWarm: async () => {},
  warmAsOf: async () => null,
  listTopTokens: async () => [],
  getByTokenKey: async () => new Map(),
  ensureTokenKey: async () => {},
  markCgkChecked: async () => {},
  linkTokenKeyToCgk: async () => {},
  getByRefs: async () => new Map(),
  putPrices: async () => {},
};

describe("interface shapes", () => {
  it("TokenProvider is implementable", async () => {
    expect(await source.fetchMarkets({ topN: 1 })).toEqual([]);
  });
  it("TokenStore is implementable", async () => {
    expect((await store.getByTokenKey(["eip155:1/erc20:0x0"])).size).toBe(0);
  });
});
