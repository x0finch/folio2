import type { CoinId, TokenRef } from "@folio/tokens-basic";
import { describe, expect, it } from "vitest";
import { normalizeSymbol } from "../src/normalize";
import { chooseResolution, pickByConfidence } from "../src/resolve";

const cg = (id: string): TokenRef => ({ source: "coingecko", coinId: id as CoinId });

describe("normalizeSymbol", () => {
  it("trims + uppercases", () => {
    expect(normalizeSymbol("  usdc ")).toBe("USDC");
    expect(normalizeSymbol("Eth")).toBe("ETH");
  });
});

describe("pickByConfidence", () => {
  it("top-rank best → high", () => {
    expect(
      pickByConfidence([
        { ref: cg("usd-coin"), marketCapRank: 6 },
        { ref: cg("usdc-scam"), marketCapRank: 9000 },
      ]),
    ).toEqual({ ref: cg("usd-coin"), confidence: "high" });
  });
  it("single candidate → high", () => {
    expect(pickByConfidence([{ ref: cg("ethereum"), marketCapRank: 2 }])).toEqual({
      ref: cg("ethereum"),
      confidence: "high",
    });
  });
  it("close ranks, both off top → low", () => {
    expect(
      pickByConfidence([
        { ref: cg("foo-a"), marketCapRank: 800 },
        { ref: cg("foo-b"), marketCapRank: 820 },
      ]),
    ).toEqual({ ref: cg("foo-a"), confidence: "low" });
  });
  it("dominant runner gap → high", () => {
    expect(
      pickByConfidence([
        { ref: cg("a"), marketCapRank: 100 },
        { ref: cg("b"), marketCapRank: 600 },
      ]),
    ).toEqual({ ref: cg("a"), confidence: "high" });
  });
  it("best ranked, others unranked → high", () => {
    expect(pickByConfidence([{ ref: cg("a"), marketCapRank: 300 }, { ref: cg("b") }])).toEqual({
      ref: cg("a"),
      confidence: "high",
    });
  });
  it("all unranked → low", () => {
    expect(pickByConfidence([{ ref: cg("a") }, { ref: cg("b") }])?.confidence).toBe("low");
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
