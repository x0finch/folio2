import { describe, expect, it } from "vitest";
import { parseBalances } from "../../../src/balance/coinstats/parse";
import cosmosFixture from "./fixtures/cosmos.json";
import cosmosExpected from "./fixtures/expected-cosmos.json";
import solanaExpected from "./fixtures/expected-solana.json";
import suiExpected from "./fixtures/expected-sui.json";
import solanaFixture from "./fixtures/solana.json";
import suiFixture from "./fixtures/sui.json";

// Goldens are split by chain: for each chain, a recorded wallet/balance response (input) to a structured expectation (output), calling parseBalances with that
// chain's connectionId as fallbackChain, with the expectation pinned in a file. Covers: value=amount*price, kind=spot, each coin carrying its chain,
// null price to 0, native coins (no contract) get no tokenRef, skipping rows without symbol; and coins without a chain falling back to fallbackChain.
describe("parseBalances: per-chain golden (fixture in, fixture out)", () => {
  it("solana (including one skipped row without symbol)", () => {
    const out = parseBalances(solanaFixture, "solana");
    expect(out).toEqual(solanaExpected);
    expect(out.every((b) => b.symbol.length > 0)).toBe(true); // no empty symbol
  });

  it("sui (connectionId=sui-wallet; a contract token without chain falls back to fallbackChain: chain:sui-wallet/…)", () => {
    // sui's connectionId is "sui-wallet" (not "sui"). A coin without a chain field goes through fallbackChain,
    // so its tokenRef lands on chain:sui-wallet (behaviour preserved, same as the old @folio/balances).
    expect(parseBalances(suiFixture, "sui-wallet")).toEqual(suiExpected);
  });

  it("cosmos", () => {
    expect(parseBalances(cosmosFixture, "cosmos")).toEqual(cosmosExpected);
  });
});
