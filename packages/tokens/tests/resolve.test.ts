import { describe, expect, it } from "vitest";
import { OVERRIDES } from "../src/constants";
import {
  chooseResolution,
  lookupByContract,
  lookupBySymbol,
  normalizeSymbol,
  pickByConfidence,
  resolve,
} from "../src/resolve";
import type { CoinId, TokenCandidate, TokenIndex, TokenRef } from "../src/types";

const cg = (id: string): TokenRef => ({ source: "coingecko", coinId: id as CoinId });

// USDC's real Ethereum contract (lowercased in the index).
const USDC_CONTRACT = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const index: TokenIndex = {
  platforms: new Map([
    ["ethereum", "ethereum"],
    ["polygon", "polygon-pos"],
  ]),
  byContract: new Map([[`ethereum:${USDC_CONTRACT.toLowerCase()}`, cg("usd-coin")]]),
  bySymbol: new Map<string, TokenCandidate[]>([
    [
      "USDC",
      [
        { ref: cg("usd-coin"), marketCapRank: 6 },
        { ref: cg("usdc-scam"), marketCapRank: 9000 },
      ],
    ],
    [
      "FOO",
      [
        { ref: cg("foo-a"), marketCapRank: 800 },
        { ref: cg("foo-b"), marketCapRank: 820 },
      ],
    ],
    ["ETH", [{ ref: cg("ethereum"), marketCapRank: 2 }]],
  ]),
  asOf: 0,
};

describe("normalizeSymbol", () => {
  it("trims + uppercases", () => {
    expect(normalizeSymbol("  usdc ")).toBe("USDC");
    expect(normalizeSymbol("Eth")).toBe("ETH");
  });
});

describe("lookupByContract", () => {
  it("maps chain→platform and lowercases the address", () => {
    expect(lookupByContract(index, "Ethereum", USDC_CONTRACT)).toEqual(cg("usd-coin"));
  });
  it("returns null for unknown chain / contract", () => {
    expect(lookupByContract(index, "ethereum", "0xdead")).toBeNull();
    expect(lookupByContract(index, "bitcoin", USDC_CONTRACT)).toBeNull();
  });
});

describe("lookupBySymbol", () => {
  it("normalizes the symbol", () => {
    expect(lookupBySymbol(index, "usdc")).toHaveLength(2);
  });
  it("returns [] for unknown symbol", () => {
    expect(lookupBySymbol(index, "ZZZ")).toEqual([]);
  });
});

describe("pickByConfidence", () => {
  it("top-rank best → high", () => {
    expect(pickByConfidence(lookupBySymbol(index, "USDC"))).toEqual({
      ref: cg("usd-coin"),
      confidence: "high",
    });
  });
  it("single candidate → high", () => {
    expect(pickByConfidence(lookupBySymbol(index, "ETH"))).toEqual({
      ref: cg("ethereum"),
      confidence: "high",
    });
  });
  it("close ranks (no dominance, both off top) → low", () => {
    expect(pickByConfidence(lookupBySymbol(index, "FOO"))).toEqual({
      ref: cg("foo-a"),
      confidence: "low",
    });
  });
  it("dominant runner gap → high", () => {
    const picked = pickByConfidence([
      { ref: cg("a"), marketCapRank: 100 },
      { ref: cg("b"), marketCapRank: 600 },
    ]);
    expect(picked).toEqual({ ref: cg("a"), confidence: "high" });
  });
  it("best ranked, others unranked → high", () => {
    const picked = pickByConfidence([{ ref: cg("a"), marketCapRank: 300 }, { ref: cg("b") }]);
    expect(picked).toEqual({ ref: cg("a"), confidence: "high" });
  });
  it("all unranked → low", () => {
    const picked = pickByConfidence([{ ref: cg("a") }, { ref: cg("b") }]);
    expect(picked?.confidence).toBe("low");
  });
  it("injectable thresholds", () => {
    const cands = [
      { ref: cg("a"), marketCapRank: 100 },
      { ref: cg("b"), marketCapRank: 200 },
    ];
    expect(pickByConfidence(cands, { topRank: 50, dominance: 5 })?.confidence).toBe("low");
    expect(pickByConfidence(cands, { topRank: 150, dominance: 5 })?.confidence).toBe("high");
  });
  it("empty → null", () => {
    expect(pickByConfidence([])).toBeNull();
  });
});

describe("chooseResolution (waterfall order)", () => {
  const candidates = [{ ref: cg("from-symbol"), marketCapRank: 1 }];

  it("explicit ref wins over everything", () => {
    expect(
      chooseResolution(
        { symbol: "USDC", ref: cg("explicit") },
        { contractHit: cg("c"), candidates, override: cg("o") },
      ),
    ).toEqual({ ref: cg("explicit"), confidence: "high", via: "explicit" });
  });
  it("contract beats override and symbol", () => {
    expect(
      chooseResolution({ symbol: "USDC" }, { contractHit: cg("c"), candidates, override: cg("o") }),
    ).toEqual({ ref: cg("c"), confidence: "high", via: "contract" });
  });
  it("override beats symbol", () => {
    expect(chooseResolution({ symbol: "USDC" }, { candidates, override: cg("o") })).toEqual({
      ref: cg("o"),
      confidence: "high",
      via: "override",
    });
  });
  it("symbol when nothing stronger", () => {
    expect(chooseResolution({ symbol: "USDC" }, { candidates })).toEqual({
      ref: cg("from-symbol"),
      confidence: "high",
      via: "symbol",
    });
  });
  it("none when nothing resolves", () => {
    expect(chooseResolution({ symbol: "ZZZ" }, {})).toEqual({
      ref: null,
      confidence: "low",
      via: "none",
    });
  });
});

describe("resolve (public entry, end-to-end)", () => {
  it("on-chain → via contract", () => {
    expect(resolve(index, { symbol: "USDC", chain: "ethereum", contract: USDC_CONTRACT })).toEqual({
      ref: cg("usd-coin"),
      confidence: "high",
      via: "contract",
    });
  });
  it("symbol-only major → via symbol high", () => {
    expect(resolve(index, { symbol: "ETH" })).toEqual({
      ref: cg("ethereum"),
      confidence: "high",
      via: "symbol",
    });
  });
  it("ambiguous symbol → via symbol low", () => {
    expect(resolve(index, { symbol: "FOO" })).toEqual({
      ref: cg("foo-a"),
      confidence: "low",
      via: "symbol",
    });
  });
  it("override (not in index) → via override", () => {
    expect(resolve(index, { symbol: "BTC" }, OVERRIDES)).toEqual({
      ref: cg("bitcoin"),
      confidence: "high",
      via: "override",
    });
  });
  it("explicit ref short-circuits", () => {
    expect(resolve(index, { symbol: "anything", ref: cg("pinned") })).toEqual({
      ref: cg("pinned"),
      confidence: "high",
      via: "explicit",
    });
  });
  it("unknown → none", () => {
    expect(resolve(index, { symbol: "ZZZ" }, OVERRIDES)).toEqual({
      ref: null,
      confidence: "low",
      via: "none",
    });
  });
});
