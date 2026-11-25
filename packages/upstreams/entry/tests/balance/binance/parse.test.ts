import { describe, expect, it } from "vitest";
import {
  parseAccountBalances,
  parseCoinmFuturesAccount,
  parseEarnPositions,
  parseFundingAssets,
  parseFuturesAccount,
} from "../../../src/balance/binance/parse";
import account from "./fixtures/account.json";
import coinmAccount from "./fixtures/coinm-account.json";
import earnFlexible from "./fixtures/earn-flexible.json";
import earnLocked from "./fixtures/earn-locked.json";
import expected from "./fixtures/expected-balances.json";
import expectedCoinm from "./fixtures/expected-coinm-balances.json";
import expectedEarn from "./fixtures/expected-earn-balances.json";
import expectedFunding from "./fixtures/expected-funding-balances.json";
import expectedFutures from "./fixtures/expected-futures-balances.json";
import fundingAssets from "./fixtures/funding-assets.json";
import futuresAccount from "./fixtures/futures-account.json";
import prices from "./fixtures/prices.json";

// JSON has no undefined, so expected omits undefined fields (toEqual treats missing == undefined).
describe("parseAccountBalances (golden: fixtures in → fixture out)", () => {
  const balances = parseAccountBalances(account, prices);

  it("maps the recorded account + price map to expected-balances", () => {
    // ETH has locked=1 → only its row carries a Locked note.
    expect(balances).toEqual(expected);
    // BNB has zero balance → excluded
    expect(balances.find((b) => b.symbol === "BNB")).toBeUndefined();
  });

  it("skips LD-prefixed earn shares (LDBNB, duplicated by the earn wallet) but keeps short real coins like LDO", () => {
    const rows = parseAccountBalances(
      {
        balances: [
          { asset: "LDBNB", free: "1", locked: "0" },
          { asset: "LDO", free: "2", locked: "0" },
          { asset: "BTC", free: "0.5", locked: "0" },
        ],
      },
      { LDOUSDT: 10, BTCUSDT: 60000 },
    );
    expect(rows.map((r) => r.symbol)).toEqual(["LDO", "BTC"]);
  });
});

describe("parseFuturesAccount (golden: fixture in → fixture out)", () => {
  const balances = parseFuturesAccount(futuresAccount);

  it("maps fapi account → perp_equity + perp_position (liquidation null, zero positions skipped)", () => {
    expect(balances).toEqual(expectedFutures);
  });

  it("net-worth invariant: Σ value === account equity (positions value 0)", () => {
    const total = balances.reduce((s, b) => s + b.value, 0);
    expect(total).toBe(12500.5);
  });

  it("empty account (no equity, no positions) → empty array", () => {
    expect(parseFuturesAccount({ totalMarginBalance: "0", positions: [] })).toEqual([]);
  });
});

// Integer prices × binary-exact quantities keep the products exact (no float error).
const COINM_PRICES = { BTCUSDT: 60000, ETHUSDT: 3000 };

describe("parseCoinmFuturesAccount (golden: fixture + prices in → fixture out)", () => {
  const balances = parseCoinmFuturesAccount(coinmAccount, COINM_PRICES);

  it("converts each coin's marginBalance/notional/PnL to USD: one equity row + position rows", () => {
    expect(balances).toEqual(expectedCoinm);
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
    expect(parseCoinmFuturesAccount({ assets: [], positions: [] }, COINM_PRICES)).toEqual([]);
  });
});

const FUNDING_PRICES = { BTCUSDT: 60000 };

describe("parseFundingAssets (golden)", () => {
  it("sums all balance states, values via ticker, skips zero (dust) balances", () => {
    expect(parseFundingAssets(fundingAssets, FUNDING_PRICES)).toEqual(expectedFunding);
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

// redeemDate is a fixed ms value so MM/DD is stable.
const EARN_PRICES = { BTCUSDT: 60000 };

describe("parseEarnPositions (golden)", () => {
  it("flexible + locked → spot rows with APY/lock notes, ticker-valued, zero balances skipped", () => {
    expect(parseEarnPositions(earnFlexible, earnLocked, EARN_PRICES)).toEqual(expectedEarn);
  });

  it("no earn positions → empty array", () => {
    expect(parseEarnPositions({ rows: [] }, { rows: [] }, EARN_PRICES)).toEqual([]);
  });
});
