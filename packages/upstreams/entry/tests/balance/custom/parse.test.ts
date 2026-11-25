import { describe, expect, it } from "vitest";
import { type CustomConfig, decodeCustomConfig } from "../../../src/balance/custom/config";
import { parseRows } from "../../../src/balance/custom/parse";
import fixture from "./fixtures/config.json";
import page1 from "./fixtures/holdings-page-1.json";
import page2 from "./fixtures/holdings-page-2.json";

const configOf = (change: Record<string, unknown> = {}): CustomConfig => {
  const result = decodeCustomConfig(JSON.stringify({ ...fixture, ...change }));
  if (!result.ok) throw new Error(result.message);
  return result.config;
};

const fields = fixture.fields;

describe("parseRows", () => {
  it("golden: the fixture pages", () => {
    const rows = [...page1.data.holdings, ...page2.data.holdings];
    expect(parseRows(rows, configOf())).toEqual({
      readable: 5,
      balances: [
        {
          kind: "spot",
          symbol: "ETH",
          amount: 1.5,
          price: 3000.5,
          value: 4500.75,
          tokenRef: "custom/custom:API.VAULT.EXAMPLE:EVM:1:ETH",
          name: "Ether",
        },
        {
          kind: "spot",
          symbol: "USDC",
          amount: 250,
          price: 1,
          value: 250,
          tokenRef: "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          name: "USD Coin",
        },
        {
          kind: "spot",
          symbol: "PTS",
          amount: 42,
          value: 0,
          tokenRef: "custom/custom:API.VAULT.EXAMPLE:PTS",
          name: "Vault points",
        },
        {
          kind: "spot",
          symbol: "SOL",
          amount: 2,
          value: 0,
          tokenRef: "custom/custom:API.VAULT.EXAMPLE:SOLANA:SOL",
          name: "Solana",
        },
      ],
    });
  });

  it("values a row at the source's price when it gives one, else at 0; never a selfPrice", () => {
    const { balances } = parseRows([...page1.data.holdings, ...page2.data.holdings], configOf());
    for (const row of balances) {
      expect(row.selfPrice).toBeUndefined();
      expect(row.value).toBe(row.price === undefined ? 0 : row.amount * row.price);
    }
  });

  it("never mints an issued ref", () => {
    const { balances } = parseRows([...page1.data.holdings], configOf());
    for (const row of balances) expect(row.tokenRef).not.toContain("issued:");
  });

  it("without chain fields every row is keyed by host and symbol", () => {
    const config = configOf({ fields: { symbol: fields.symbol, amount: "usd" } });
    const { balances } = parseRows(page1.data.holdings, config);
    expect(balances.map((b) => b.tokenRef)).toEqual([
      "custom/custom:API.VAULT.EXAMPLE:ETH",
      "custom/custom:API.VAULT.EXAMPLE:USDC",
    ]);
  });

  it("scales raw integers past 2^53 without rounding first", () => {
    const config = configOf({ fields: { symbol: "s", amount: "a", decimals: "d" } });
    // Dividing the rounded raw number gives 1.1529651045736466 here.
    const { balances } = parseRows([{ s: "X", a: "1152965104573646484", d: "18" }], config);
    expect(balances[0]?.amount).toBe(1.1529651045736464);
    const small = parseRows([{ s: "X", a: "5", d: 3 }], config).balances[0];
    expect(small?.amount).toBe(0.005);
  });

  it("with decimals, a fractional or negative raw amount is unreadable", () => {
    const config = configOf({ fields: { symbol: "s", amount: "a", decimals: "d" } });
    expect(parseRows([{ s: "X", a: "1.5", d: 2 }], config).readable).toBe(0);
    expect(parseRows([{ s: "X", a: "-5", d: 2 }], config).readable).toBe(0);
    expect(parseRows([{ s: "X", a: "5", d: 99 }], config).readable).toBe(0);
  });

  it("without decimals, takes numbers and numeric strings as they are", () => {
    const config = configOf({ fields: { symbol: "s", amount: "a" } });
    const { balances } = parseRows(
      [
        { s: "A", a: 1.25 },
        { s: "B", a: " 2.5 " },
        { s: "C", a: "1e3" },
        { s: "D", a: "lots" },
        { s: "E", a: -1 },
      ],
      config,
    );
    expect(balances.map((b) => [b.symbol, b.amount])).toEqual([
      ["A", 1.25],
      ["B", 2.5],
      ["C", 1000],
    ]);
  });

  it("drops rows whose symbol can't name a token", () => {
    const config = configOf({ fields: { symbol: "s", amount: "a" } });
    const rows = [
      { s: "" },
      { s: "A/B", a: 1 },
      { s: "X".repeat(40), a: 1 },
      { a: 1 },
      "junk",
      null,
    ];
    expect(parseRows(rows, config)).toEqual({ balances: [], readable: 0 });
  });

  it("falls back to the custom ref when chain or contract can't form a ref", () => {
    const config = configOf({
      fields: { symbol: "s", amount: "a", chain: "c", contract: "k" },
    });
    const { balances } = parseRows(
      [
        { s: "A", a: 1, c: "evm/1" },
        { s: "B", a: 1, c: "evm:1", k: "0xabc/def" },
      ],
      config,
    );
    expect(balances.map((b) => b.tokenRef)).toEqual([
      "custom/custom:API.VAULT.EXAMPLE:A",
      "custom/custom:API.VAULT.EXAMPLE:EVM:1:B",
    ]);
  });

  it("an empty contract never claims the chain's native coin", () => {
    const config = configOf({ fields: { symbol: "s", amount: "a", chain: "c", contract: "k" } });
    const { balances } = parseRows(
      [
        { s: "ORDI", a: 1, c: "bitcoin", k: "" },
        { s: "BTC", a: 1, c: "bitcoin", k: "" },
      ],
      config,
    );
    const refs = balances.map((b) => b.tokenRef);
    expect(new Set(refs).size).toBe(2);
    expect(refs.some((r) => r.endsWith("/native"))).toBe(false);
  });

  it("a chain without a contract field never folds coins into one native ref", () => {
    const config = configOf({ fields: { symbol: "s", amount: "a", chain: "c" } });
    const { balances } = parseRows(
      [
        { s: "ETH", a: 10, c: "evm:1" },
        { s: "USDC", a: 500, c: "evm:1" },
      ],
      config,
    );
    const refs = balances.map((b) => b.tokenRef);
    expect(new Set(refs).size).toBe(2);
    expect(refs.some((r) => r.endsWith("/native"))).toBe(false);
  });

  it("a number that overflows makes its row unreadable, not the call", () => {
    const config = configOf({ fields: { symbol: "s", amount: "a", price: "p" } });
    const { balances, readable } = parseRows(
      [
        { s: "HUGE", a: "1e400" },
        { s: "X", a: "1e10", p: "1e300" },
        { s: "OK", a: 1, p: 2 },
      ],
      config,
    );
    expect(readable).toBe(2);
    expect(balances.map((b) => [b.symbol, b.value])).toEqual([
      ["X", 0],
      ["OK", 2],
    ]);
  });

  it("reads own properties only", () => {
    const config = configOf({ fields: { symbol: "s", amount: "constructor.length" } });
    expect(parseRows([{ s: "A" }], config).readable).toBe(0);
  });
});
