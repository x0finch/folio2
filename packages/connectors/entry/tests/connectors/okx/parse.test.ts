import { describe, expect, it } from "vitest";
import {
  buildPriceHint,
  earnResidualRow,
  parseBalances,
  parseFunding,
  parseSavings,
  parseStaking,
} from "../../../src/connectors/okx/parse";
import balance from "./fixtures/balance.json";
import expected from "./fixtures/expected-balances.json";
import expectedFunding from "./fixtures/expected-funding-balances.json";
import expectedSavings from "./fixtures/expected-savings-balances.json";
import expectedStaking from "./fixtures/expected-staking-balances.json";
import funding from "./fixtures/funding.json";
import savings from "./fixtures/savings.json";
import staking from "./fixtures/staking.json";

// Two fixtures correspond one to one: balance.json (the recorded /api/v5/account/balance response) and expected-balances.json (the parsed expectation).
// Covers: cashBal to amount (uPnL excluded), price=eqUsd/eq (market price), value=amount x price, skipping zero/empty (DUST).
// JSON has no undefined, so expected omits undefined fields (toEqual treats a missing key as undefined).
describe("parseBalances (golden: fixture in → fixture out)", () => {
  it("maps the recorded balance details to expected-balances", () => {
    // per-balance note (single Note): ETH frozenBal=0.5 puts a Frozen note on that entry; the rest have none.
    // Staking receipt tokens (OKSOL) sit in the trading account details and are counted only from here, not again by the staking endpoint.
    expect(parseBalances(balance.data[0].details)).toEqual(expected);
  });

  it("holdings take cashBal, not eq: contract unrealised PnL (uPnL) does not leak into spot", () => {
    // USDT as contract margin: eq=1200 (including 200 unrealised), cashBal=1000 (real cash). Taking cashBal gives amount=1000;
    // the price is eqUsd/eq=1 (unrelated to uPnL), value=1000. Wrongly using eq would inflate USDT to 1200.
    const usdt = parseBalances(balance.data[0].details).find((b) => b.symbol === "USDT");
    expect(usdt).toMatchObject({ amount: 1000, price: 1, value: 1000 });
  });

  // OKX gives `eqUsd: "0"` (sometimes eq too) for tokens it does not quote. Folding that into price 0 made valuation treat 0 as a valid own price and
  // never ask the oracle, so the token showed $0 forever. No price means no price: price omitted, value 0, same as Bybit / Binance, left to the oracle.
  it.each([
    ["eqUsd is 0", { eq: "1000", eqUsd: "0" }],
    ["eq is 0", { eq: "0", eqUsd: "0" }],
    ["eqUsd is an empty string", { eq: "1000", eqUsd: "" }],
  ])("exchange gives no price (%s): price omitted, value 0, not posing as a zero price", (_, px) => {
    const [row] = parseBalances([{ ccy: "XYZ", cashBal: "1000", frozenBal: "0", ...px }]);
    expect(row).toMatchObject({ symbol: "XYZ", amount: 1000, value: 0 });
    expect(row?.price).toBeUndefined();
  });
});

// Funding bucket golden: funding.json (the recorded /asset/balances response) + the trading account's price hint table to
// expected-funding-balances.json. Covers: bal to amount, stablecoin ~1 (USDT), trading-account price reuse (BTC),
// unpriced tokens value 0 left to the oracle (PEPE), each carrying note.group:"funding".
describe("parseFunding (golden: fixture in → fixture out)", () => {
  it("maps recorded funding assets + price hint to expected-funding-balances", () => {
    const hint = buildPriceHint(balance.data[0].details);
    expect(parseFunding(funding.data, hint)).toEqual(expectedFunding);
  });
});

// Earn bucket golden: savings/staking responses + price hint table to expectation. Covers: amt to amount, rate/apy to APY note,
// note.group:"earn", price reuse from the trading account (ETH) / stablecoin (USDT).
describe("parseSavings / parseStaking (golden: fixture in → fixture out)", () => {
  const hint = buildPriceHint(balance.data[0].details);
  it("savings: amt→amount, rate→'Flexible · X% APY' note, group earn", () => {
    expect(parseSavings(savings.data, hint)).toEqual(expectedSavings);
  });
  it("staking: investData[].amt→amount, protocol+apy note, group earn", () => {
    expect(parseStaking(staking.data, hint)).toEqual(expectedStaking);
  });
});

// Earn residual to a synthetic aggregate row counted into net worth: the fetched earn sub-items summed vs the asset-valuation earn bucket.
describe("earnResidualRow", () => {
  const hint = buildPriceHint(balance.data[0].details);
  const earnItems = [...parseSavings(savings.data, hint), ...parseStaking(staking.data, hint)];

  it("earn bucket > fetched sum: yields one synthetic row with value=residual (counted into net worth), with a neutral note", () => {
    // earn bucket 12000; fetched USDT 5000 + ETH 6000 = 11000; residual 1000.
    const row = earnResidualRow(12000, earnItems, hint);
    expect(row).toMatchObject({
      kind: "spot",
      value: 1000,
      symbol: "USD", // the number is a USD valuation, so the unit is USD (not a token count)
      name: "OKX Earn (Uncategorized)",
      tokenRef: "okx/custom:EARN-UNCATEGORIZED",
    });
    expect(row?.logo).toMatch(/^data:image\/svg\+xml/); // inline OKX mark (attached directly as a tokenLogoUrl data: URI)
    expect(row?.note?.group).toBe("earn");
    expect(String(row?.note?.content)).toContain("$1,000");
  });

  it("earn bucket ~ fetched sum (difference <= threshold): no row", () => {
    expect(earnResidualRow(11000, earnItems, hint)).toBeUndefined();
  });

  it("an earn sub-item cannot be priced (residual untrustworthy): no row (do not pollute net worth with dirty data)", () => {
    // Append an unpriced non-stablecoin earn item, so unpriced>0 suppresses it.
    const withUnpriced = [
      ...earnItems,
      { symbol: "XYZ", amount: 1, value: 0, kind: "spot", tokenRef: "okx/issued:XYZ" } as const,
    ];
    expect(earnResidualRow(99999, withUnpriced, hint)).toBeUndefined();
  });
});
