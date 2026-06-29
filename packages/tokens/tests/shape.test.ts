import { describe, expect, it } from "vitest";
import type { TokenSource } from "../src/source";
import type { TokenStore } from "../src/store";
import type { TokenIndex } from "../src/types";

const emptyIndex: TokenIndex = {
  byContract: new Map(),
  bySymbol: new Map(),
  platforms: new Map(),
  asOf: 0,
};

// Stubs prove the interfaces are implementable (the contract compiles to a real shape).
const source = {
  fetchIndex: async () => emptyIndex,
  fetchMarkets: async () => [],
  fetchPrices: async () => new Map(),
} satisfies TokenSource;

const store = {
  getIndex: async () => null,
  putIndex: async () => {},
  getInfo: async () => new Map(),
  putInfo: async () => {},
  getPrices: async () => new Map(),
  putPrices: async () => {},
  isAbsent: async () => false,
  putAbsent: async () => {},
} satisfies TokenStore;

describe("interface shapes", () => {
  // The `satisfies` annotations above are the real proof (compile-time); these confirm the stubs run.
  it("TokenSource is implementable", async () => {
    expect(await source.fetchIndex()).toBe(emptyIndex);
  });

  it("TokenStore is implementable", async () => {
    expect(await store.getIndex()).toBeNull();
  });
});
