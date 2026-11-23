import type { TokenCandidate } from "@folio/oracle-basic";
import { RESOLUTION_DOMINANCE, RESOLUTION_TOP_RANK } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { pickByConfidence } from "../src/tokens/mint";

// The judge of the symbol tier: with several candidates for one symbol, whether to resolve and to which.
// Tested directly because the mint-side cases never reached it (contract refs are gated out earlier).
// Errors are asymmetric: under-resolving shows an unrecognised row the user can rebind; over-resolving merges a fake
// token's amount into the real one, frozen in the snapshot. So bias conservative.

const cand = (ref: string, marketCapRank?: number): TokenCandidate => ({ ref, marketCapRank });

describe("no candidates / a sole candidate", () => {
  it("no candidates: not resolved", () => {
    expect(pickByConfidence([])).toBeUndefined();
  });

  it("a sole candidate: resolved, even without rank (nothing to confuse it with)", () => {
    expect(pickByConfidence([cand("src/issued:lonely")])).toBe("src/issued:lonely");
  });
});

describe(`best within top-${RESOLUTION_TOP_RANK}: resolved`, () => {
  it("a head token beats any long-tail namesake", () => {
    const got = pickByConfidence([cand("src/issued:scam", 900), cand("src/issued:bitcoin", 1)]);
    expect(got).toBe("src/issued:bitcoin");
  });

  it("exactly on the threshold: resolved (closed interval)", () => {
    const got = pickByConfidence([
      cand("src/issued:edge", RESOLUTION_TOP_RANK),
      cand("src/issued:other", RESOLUTION_TOP_RANK + 1),
    ]);
    expect(got).toBe("src/issued:edge");
  });

  // One rank outside goes to the dominance check: 51 vs 52 dominates nothing, so not resolved.
  it("one rank outside: falls to dominance, and 51 vs 52 is no domination: not resolved", () => {
    const got = pickByConfidence([
      cand("src/issued:a", RESOLUTION_TOP_RANK + 1),
      cand("src/issued:b", RESOLUTION_TOP_RANK + 2),
    ]);
    expect(got).toBeUndefined();
  });

  it("ordering ignores input order: a best listed later is still resolved", () => {
    expect(pickByConfidence([cand("src/issued:z", 999), cand("src/issued:a", 2)])).toBe(
      "src/issued:a",
    );
  });
});

describe("only the best is ranked: unambiguous", () => {
  it("runner-up has no rank (not in warm): best resolved, even outside the threshold", () => {
    const got = pickByConfidence([cand("src/issued:known", 900), cand("src/issued:nameless")]);
    expect(got).toBe("src/issued:known");
  });

  it("none ranked: not resolved (nothing to compare; separate rows preferred)", () => {
    expect(pickByConfidence([cand("src/issued:a"), cand("src/issued:b")])).toBeUndefined();
  });
});

describe(`dominating the runner-up by ${RESOLUTION_DOMINANCE}x: resolved`, () => {
  // Smaller rank is better, so dominance means the runner-up's rank is a multiple of the best's.
  it("multiple reached: resolved", () => {
    const got = pickByConfidence([
      cand("src/issued:big", 100),
      cand("src/issued:small", 100 * RESOLUTION_DOMINANCE),
    ]);
    expect(got).toBe("src/issued:big");
  });

  it("just short: not resolved (one rank below the threshold)", () => {
    const got = pickByConfidence([
      cand("src/issued:big", 100),
      cand("src/issued:small", 100 * RESOLUTION_DOMINANCE - 1),
    ]);
    expect(got).toBeUndefined();
  });

  it("only best and runner-up matter; a far third has no effect", () => {
    const got = pickByConfidence([
      cand("src/issued:a", 100),
      cand("src/issued:b", 120),
      cand("src/issued:c", 99999),
    ]);
    expect(got).toBeUndefined();
  });
});
