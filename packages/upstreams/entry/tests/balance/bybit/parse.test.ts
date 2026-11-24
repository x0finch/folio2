import { describe, expect, it } from "vitest";
import {
  buildPriceHint,
  parseEarn,
  parseFunding,
  parseUnified,
} from "../../../src/balance/bybit/parse";
import earnFlexible from "./fixtures/earn-flexible.json";
import earnOnchain from "./fixtures/earn-onchain.json";
import expectedFlexible from "./fixtures/expected-flexible-earn.json";
import expectedFunding from "./fixtures/expected-funding-balances.json";
import expectedOnchain from "./fixtures/expected-onchain-earn.json";
import expectedUnified from "./fixtures/expected-unified-balances.json";
import funding from "./fixtures/funding.json";
import walletBalance from "./fixtures/wallet-balance.json";

// Two fixtures correspond one to one: wallet-balance.json (the recorded /v5/account/wallet-balance UNIFIED response) and expected-unified-balances.json.
// Covers: walletBalance to amount (uPnL excluded, equity not used), usdValue to value (own valuation), price=usdValue/amount,
// skipping walletBalance<=0 (DUST), locked to a Locked note.
describe("parseUnified (golden: fixture in → fixture out)", () => {
  const coins = walletBalance.result.list[0].coin;

  it("maps recorded UNIFIED coins to expected-unified-balances", () => {
    expect(parseUnified(coins)).toEqual(expectedUnified);
  });

  it("holdings take walletBalance, not equity: contract unrealised profit does not leak into spot", () => {
    // BTC: walletBalance=0.05 (cash), equity=0.06 (including 0.01 unrealised). Taking walletBalance gives amount=0.05;
    // wrongly using equity would count unrealised profit as spot holdings.
    const btc = parseUnified(coins).find((b) => b.symbol === "BTC");
    expect(btc).toMatchObject({ amount: 0.05, value: 3000 });
  });
});

// Funding account (FUND) golden: funding.json (the recorded /asset/transfer/query-account-coins-balance response) + the unified account's price hint
// table to expected-funding-balances.json. Covers: walletBalance to amount, stablecoin ~1 (USDT), unified-account price reuse (BTC),
// unpriced tokens value 0 left to the oracle (WLFI), each carrying note.group:"funding".
describe("parseFunding (golden: fixture in → fixture out)", () => {
  it("maps recorded funding assets + price hint to expected-funding-balances", () => {
    const hint = buildPriceHint(walletBalance.result.list[0].coin);
    expect(parseFunding(funding.result.balance, hint)).toEqual(expectedFunding);
  });
});

// Earn golden: earn-flexible/onchain.json + the unified account's price hint table to expectation. Covers: amount to amount, category label (Flexible / On-chain),
// note.group:"earn", price reuse from the unified account (BTC) / stablecoin (USDT), skipping amount<=0 (redeemed residue).
// No APY is marked (Bybit's position endpoint has no APR).
describe("parseEarn (golden: fixture in → fixture out)", () => {
  const hint = buildPriceHint(walletBalance.result.list[0].coin);
  it("flexible: amount to amount, category note content='Flexible', group earn; skips amount=0", () => {
    expect(parseEarn(earnFlexible.result.list, "Flexible", hint)).toEqual(expectedFlexible);
  });
  it("on-chain: category note content='On-chain', group earn", () => {
    expect(parseEarn(earnOnchain.result.list, "On-chain", hint)).toEqual(expectedOnchain);
  });
});
