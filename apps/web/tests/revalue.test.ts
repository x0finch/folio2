import type { Balance } from "@folio/connectors-basic";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { revalue } from "@/lib/server/sync/revalue";
import { runWithOracle } from "./oracle-stub";

//
function fakeTokens(prices: Record<string, number>) {
  const asked: string[] = [];
  const batches: string[][] = [];
  const tokens = {
    pricesOf: (tokenIds: readonly string[]) =>
      Effect.sync(() => {
        batches.push([...tokenIds]);
        asked.push(...tokenIds);
        const out = new Map<string, { unitPrice: number; asOf: number; stale: boolean }>();
        for (const id of tokenIds) {
          const unitPrice = prices[id];
          if (unitPrice !== undefined) out.set(id, { unitPrice, asOf: 0, stale: false });
        }
        return out;
      }),
  };
  return { tokens, asked, batches };
}

function fakeFx(rates: Record<string, number> = {}) {
  const asked: string[] = [];
  const fx = {
    resolve: (currency: string) =>
      Effect.sync(() => {
        asked.push(currency);
        const c = currency.trim().toUpperCase();
        return Option.fromNullishOr(c === "USD" ? 1 : rates[c]);
      }),
  };
  return { fx, asked };
}

const NO_FX = fakeFx().fx;

const PRICES = { tk_btc: 65000, tk_ton: 5 };
const IDS = new Map([
  ["bitcoin/native", "tk_btc"],
  ["binance/issued:BTC", "tk_btc"],
  ["coingecko/issued:bitcoin", "tk_btc"],
  ["coingecko/issued:the-open-network", "tk_ton"],
  ["binance/issued:PRIVATETOKEN", "tk_private"],
]);

const spot = (over: Partial<Balance> & Pick<Balance, "symbol" | "amount" | "value">): Balance =>
  ({ kind: "spot", ...over }) as Balance;

describe("revalue: mark-to-market kinds (no authoritative own price, always source price)", () => {
  it("recognized: value = quantity × market price", async () => {
    const { tokens } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(
        true,
        [spot({ symbol: "BTC", amount: 0.5, value: 1, tokenRef: "coingecko/issued:bitcoin" })],
        IDS,
      ),
    );
    expect(out[0].value).toBe(32500); // 0.5 × 65000
  });

  it("several holdings: price table read once in batch, each id asked once", async () => {
    const { tokens, batches } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(
        true,
        [
          spot({ symbol: "BTC", amount: 1, value: 0, tokenRef: "bitcoin/native" }),
          spot({ symbol: "BTC", amount: 2, value: 0, tokenRef: "coingecko/issued:bitcoin" }),
          spot({
            symbol: "TON",
            amount: 10,
            value: 0,
            tokenRef: "coingecko/issued:the-open-network",
          }),
        ],
        IDS,
      ),
    );
    expect(out.map((b) => b.value)).toEqual([65000, 130000, 50]);
    expect(batches).toEqual([["tk_btc", "tk_ton"]]);
  });

  it("bitcoin:provider gives only amount (value=0): computed at market price", async () => {
    const { tokens } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(
        true,
        [spot({ symbol: "BTC", amount: 0.08, value: 0, tokenRef: "bitcoin/native" })],
        IDS,
      ),
    );
    expect(out[0].value).toBe(5200); // 0.08 × 65000
  });

  it("mint without id: keeps the provider value and never asks for a price", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(
        true,
        [
          spot({
            symbol: "PRIVATETOKEN",
            amount: 10,
            value: 99,
            tokenRef: "manual/custom:PRIVATETOKEN",
          }),
        ],
        IDS,
      ),
    );
    expect(out[0].value).toBe(99);
    expect(asked).toEqual([]);
  });

  it("custom source: a coin the market knows takes the market price over the source's", async () => {
    const { tokens } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(
        true,
        [spot({ symbol: "BTC", amount: 2, price: 1, value: 2, tokenRef: "bitcoin/native" })],
        IDS,
      ),
    );
    expect(out[0]).toMatchObject({ price: 65000, value: 130000 });
    expect(out[0].selfPrice).toBeUndefined();
  });

  it("no tokenRef at all (imported legacy row): keeps the value, no price lookup", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(true, [spot({ symbol: "FOO", amount: 1, value: 7 })], IDS),
    );
    expect(out[0].value).toBe(7);
    expect(asked).toEqual([]);
  });
});

describe("revalue: non-mark-to-market kinds (authoritative own price)", () => {
  it("self-first: captures selfPrice, value unchanged, **no upstream call**", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(
        false,
        [spot({ symbol: "BTC", amount: 2, value: 120000, tokenRef: "binance/issued:BTC" })],
        IDS,
      ),
    );
    expect(out[0].value).toBe(120000);
    expect(out[0].selfPrice).toBe(60000);
    expect(asked).toEqual([]);
  });

  it("self-first with own price 0: treated as no price, falls back to source price", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(
        false,
        [spot({ symbol: "BTC", amount: 2, value: 0, price: 0, tokenRef: "binance/issued:BTC" })],
        IDS,
      ),
    );
    expect(asked).toEqual(["tk_btc"]);
    expect(out[0].value).toBe(130000); // 2 × 65000
    expect(out[0].selfPrice).toBeUndefined();
  });

  it("source-first: uses source price, selfPrice kept (switchable back)", async () => {
    const { tokens } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(
        false,
        [spot({ symbol: "BTC", amount: 2, value: 120000, tokenRef: "binance/issued:BTC" })],
        IDS,
        "source-first",
      ),
    );
    expect(out[0].value).toBe(130000); // 2 × 65000
    expect(out[0].price).toBe(65000);
    expect(out[0].selfPrice).toBe(60000);
  });

  it("source-first but upstream has no price for the token: falls back to own price", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(
        false,
        [
          spot({
            symbol: "PRIVATETOKEN",
            amount: 10,
            value: 99,
            tokenRef: "binance/issued:PRIVATETOKEN",
          }),
        ],
        IDS,
        "source-first",
      ),
    );
    expect(out[0].value).toBe(99);
    expect(out[0].selfPrice).toBe(9.9);
    expect(asked).toEqual(["tk_private"]);
  });
});

describe("revalue: perp rows keep the provider value", () => {
  const perp = (kind: "perp_position" | "perp_equity", amount: number, value: number): Balance =>
    ({
      symbol: "ETH",
      amount,
      value,
      kind,
      tokenRef: "hyperliquid/issued:ETH",
    }) as unknown as Balance;

  it("perp_position value stays 0 (even with a big quantity and a known token), not repriced to quantity × token price", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(true, [perp("perp_position", -40391.56, 0)], IDS),
    );
    expect(out[0].value).toBe(0);
    expect(asked).toEqual([]);
  });

  it("perp_equity keeps the account equity, not overwritten by quantity × token price", async () => {
    const { tokens } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: NO_FX },
      revalue(true, [perp("perp_equity", 34427709, 34425196)], IDS),
    );
    expect(out[0].value).toBe(34425196);
  });
});

describe("revalue: fiat goes through FX", () => {
  const fiat = (code: string, amount: number, value = 0): Balance =>
    ({ kind: "spot", symbol: code, amount, value, tokenRef: `fiat/issued:${code}` }) as Balance;

  it("USD: display price always 1, value = quantity (unaffected by rate jitter)", async () => {
    const { tokens } = fakeTokens(PRICES);
    const { fx } = fakeFx();
    const out = await runWithOracle({ tokens, fx: fx }, revalue(true, [fiat("USD", 100)], IDS));
    expect(out[0].price).toBe(1);
    expect(out[0].value).toBe(100);
  });

  it("non-USD: value = quantity × injected rate; value follows rate changes", async () => {
    const { tokens } = fakeTokens(PRICES);
    const out1 = await runWithOracle(
      { tokens, fx: fakeFx({ CNY: 0.14 }).fx },
      revalue(true, [fiat("CNY", 1000)], IDS),
    );
    expect(out1[0].price).toBe(0.14);
    expect(out1[0].value).toBeCloseTo(140); // 1000 × 0.14

    const out2 = await runWithOracle(
      { tokens, fx: fakeFx({ CNY: 0.15 }).fx },
      revalue(true, [fiat("CNY", 1000)], IDS),
    );
    expect(out2[0].value).toBeCloseTo(150);
  });

  it("computed on every call: selfPrice not frozen (next revalue uses the then-current rate)", async () => {
    const { tokens } = fakeTokens(PRICES);
    const out = await runWithOracle(
      { tokens, fx: fakeFx({ EUR: 1.1 }).fx },
      revalue(true, [fiat("EUR", 10)], IDS),
    );
    expect(out[0].selfPrice).toBeUndefined();
  });

  it("no token price lookup: fiat does not go through pricesOf (it has no upstream price)", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    await runWithOracle(
      { tokens, fx: fakeFx({ EUR: 1.1 }).fx },
      revalue(true, [fiat("EUR", 10)], IDS),
    );
    expect(asked).toEqual([]);
  });

  it("FX lacks the code (cold cache): degrades, keeps the provider value, no throw", async () => {
    const { tokens } = fakeTokens(PRICES);
    const { fx, asked } = fakeFx({});
    const out = await runWithOracle(
      { tokens, fx: fx },
      revalue(true, [fiat("CNY", 1000, 130)], IDS),
    );
    expect(out[0].value).toBe(130);
    expect(asked).toEqual(["CNY"]);
  });

  it("non-allowlisted fiat/issued:XXX is not treated as fiat: takes the normal path (mint without id keeps the value)", async () => {
    const { tokens } = fakeTokens(PRICES);
    const { asked: fxAsked, fx } = fakeFx({ XXX: 2 });
    const b = {
      kind: "spot",
      symbol: "XXX",
      amount: 5,
      value: 7,
      tokenRef: "fiat/issued:XXX",
    } as Balance;
    const out = await runWithOracle({ tokens, fx: fx }, revalue(true, [b], IDS));
    expect(out[0].value).toBe(7);
    expect(fxAsked).toEqual([]);
  });
});
