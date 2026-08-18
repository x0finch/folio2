import { describe, expect, it } from "vitest";
import { matchSegments } from "../src/components/token-search";

describe("matchSegments", () => {
  it("empty query → whole text unmatched", () => {
    expect(matchSegments("Bitcoin", "")).toEqual([{ text: "Bitcoin", match: false }]);
    expect(matchSegments("Bitcoin", "   ")).toEqual([{ text: "Bitcoin", match: false }]);
  });

  it("no match → whole text unmatched", () => {
    expect(matchSegments("Ethereum", "xyz")).toEqual([{ text: "Ethereum", match: false }]);
  });

  it("is case-insensitive and preserves original casing in segments", () => {
    expect(matchSegments("Bitcoin", "bit")).toEqual([
      { text: "Bit", match: true },
      { text: "coin", match: false },
    ]);
    expect(matchSegments("WBTC", "btc")).toEqual([
      { text: "W", match: false },
      { text: "BTC", match: true },
    ]);
  });

  it("splits multiple occurrences into alternating segments", () => {
    expect(matchSegments("banana", "a")).toEqual([
      { text: "b", match: false },
      { text: "a", match: true },
      { text: "n", match: false },
      { text: "a", match: true },
      { text: "n", match: false },
      { text: "a", match: true },
    ]);
  });

  it("full match → single matched segment", () => {
    expect(matchSegments("SOL", "sol")).toEqual([{ text: "SOL", match: true }]);
  });
});
