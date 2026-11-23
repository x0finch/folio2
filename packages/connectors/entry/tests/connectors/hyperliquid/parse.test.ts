import { describe, expect, it } from "vitest";
import { parseClearinghouseState } from "../../../src/connectors/hyperliquid/parse";
import fixture from "./fixtures/clearinghouse-state.json";
import expected from "./fixtures/expected-balances.json";

// Two fixtures correspond one to one: the recorded clearinghouseState response, and expected-balances.json (the parsed expectation, pinned for comparison).
// Covers: the equity row kind:"perp_equity" (the only one carrying value) + one kind:"perp_position" row per position (value=0, detail in meta, no role);
// string fields normalised with Number(); szi sign to side (long/short); liquidationPx may be null.
describe("parseClearinghouseState (golden: fixture in → fixture out)", () => {
  it("maps the recorded response to expected-balances (kind-split, no role)", () => {
    expect(parseClearinghouseState(fixture)).toEqual(expected);
  });

  it("emits only the perp_equity row for an account with no open positions", () => {
    const balances = parseClearinghouseState({
      marginSummary: {
        accountValue: "0.0",
        totalMarginUsed: "0.0",
        totalNtlPos: "0.0",
        totalRawUsd: "0.0",
      },
      assetPositions: [],
      withdrawable: "0.0",
    });
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({ symbol: "USDC", amount: 0, value: 0, kind: "perp_equity" });
  });

  it("total value equals account equity (positions do not double-count)", () => {
    const total = parseClearinghouseState(fixture).reduce((s, b) => s + b.value, 0);
    expect(total).toBe(13109.482328);
  });
});
