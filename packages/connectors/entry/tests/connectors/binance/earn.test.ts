import { describe, expect, it } from "vitest";
import { parseEarnPositions } from "../../../src/connectors/binance/parse";
import flexible from "./fixtures/earn-flexible.json";
import locked from "./fixtures/earn-locked.json";
import expected from "./fixtures/expected-earn-balances.json";

// redeemDate is a fixed ms value so MM/DD is stable.
const PRICES = { BTCUSDT: 60000 };

describe("parseEarnPositions (golden)", () => {
  it("flexible + locked → spot rows with APY/lock notes, ticker-valued, zero balances skipped", () => {
    expect(parseEarnPositions(flexible, locked, PRICES)).toEqual(expected);
  });

  it("no earn positions → empty array", () => {
    expect(parseEarnPositions({ rows: [] }, { rows: [] }, PRICES)).toEqual([]);
  });
});
