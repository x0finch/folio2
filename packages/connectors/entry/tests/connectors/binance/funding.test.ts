import { describe, expect, it } from "vitest";
import { parseFundingAssets } from "../../../src/connectors/binance/parse";
import expected from "./fixtures/expected-funding-balances.json";
import assets from "./fixtures/funding-assets.json";

const PRICES = { BTCUSDT: 60000 };

describe("parseFundingAssets (golden)", () => {
  it("sums all balance states, values via ticker, skips zero (dust) balances", () => {
    expect(parseFundingAssets(assets, PRICES)).toEqual(expected);
  });

  it("an unpriced coin → value 0, price omitted", () => {
    expect(parseFundingAssets([{ asset: "XYZ", free: "5" }], {})).toEqual([
      {
        symbol: "XYZ",
        amount: 5,
        value: 0,
        kind: "spot",
        tokenRef: "binance/issued:XYZ",
        note: { title: "Funding", icon: "info", content: "Funding wallet", group: "funding" },
      },
    ]);
  });
});
