import { describe, expect, it } from "vitest";
import { parseAccountBalances } from "../../../src/connectors/binance/parse";
import account from "./fixtures/account.json";
import expected from "./fixtures/expected-balances.json";
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
