import { describe, expect, it } from "vitest";
import { parseCoinmFuturesAccount } from "../../../src/connectors/binance/parse";
import account from "./fixtures/coinm-account.json";
import expected from "./fixtures/expected-coinm-balances.json";

// Integer prices × binary-exact quantities keep the products exact (no float error).
const PRICES = { BTCUSDT: 60000, ETHUSDT: 3000 };

describe("parseCoinmFuturesAccount (golden: fixture + prices in → fixture out)", () => {
  const balances = parseCoinmFuturesAccount(account, PRICES);

  it("converts each coin's marginBalance/notional/PnL to USD: one equity row + position rows", () => {
    expect(balances).toEqual(expected);
  });

  it("net-worth invariant: Σ value === total USD equity (positions value 0)", () => {
    expect(balances.reduce((s, b) => s + b.value, 0)).toBe(18000);
  });

  it("an unpriced coin converts to 0", () => {
    const noPrice = parseCoinmFuturesAccount(
      { assets: [{ asset: "XYZ", marginBalance: "5" }], positions: [] },
      {},
    );
    expect(noPrice).toEqual([]); // XYZ unpriced → equity 0 → empty account
  });

  it("empty account → empty array", () => {
    expect(parseCoinmFuturesAccount({ assets: [], positions: [] }, PRICES)).toEqual([]);
  });
});
