import { describe, expect, it } from "vitest";
import { parseFuturesAccount } from "../../../src/connectors/binance/parse";
import expected from "./fixtures/expected-futures-balances.json";
import account from "./fixtures/futures-account.json";

describe("parseFuturesAccount (golden: fixture in → fixture out)", () => {
  const balances = parseFuturesAccount(account);

  it("maps fapi account → perp_equity + perp_position (liquidation null, zero positions skipped)", () => {
    expect(balances).toEqual(expected);
  });

  it("net-worth invariant: Σ value === account equity (positions value 0)", () => {
    const total = balances.reduce((s, b) => s + b.value, 0);
    expect(total).toBe(12500.5);
  });

  it("empty account (no equity, no positions) → empty array", () => {
    expect(parseFuturesAccount({ totalMarginBalance: "0", positions: [] })).toEqual([]);
  });
});
