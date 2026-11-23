import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { TokenRecord } from "@folio/oracle-basic";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { CredsToken } from "@/lib/core/manual";
import { deriveLiveAccountTotals } from "@/lib/core/portfolio";
import { buildManualSnapshot, manualUnitPrices } from "@/lib/server/manual/snapshot";
import { runWithOracle } from "./oracle-stub";

// Manual creds.tokens (+ per-token live price) -> SnapshotWithBalances. Live price is baked into
// usdValue/totalUsd (falls back to unitPrice); selfPrice=null means mark-to-market.
const TS = 1_700_000_000_000;

const tok = (over: Partial<CredsToken>): CredsToken => ({
  id: "tk-BTC",
  symbol: "BTC",
  amount: 2,
  fallbackPrice: 100,
  ref: null,
  ...over,
});

describe("buildManualSnapshot", () => {
  // tokenId must be set: enrichment, prewarm and price refresh all key on it.
  it("one spot balance per token, amount/tokenId passed through (symbol lives on Token)", () => {
    const snap = buildManualSnapshot("acc1", [tok({ id: "tk-BTC", amount: 2 })], [undefined], TS);
    expect(snap.balances).toHaveLength(1);
    expect(snap.balances[0]).toMatchObject({ amount: 2, kind: "spot", tokenId: "tk-BTC" });
  });

  it("live price -> usdValue = amount x live price (not unitPrice)", () => {
    const snap = buildManualSnapshot("acc1", [tok({ amount: 2, fallbackPrice: 100 })], [130], TS);
    expect(snap.balances[0].usdValue).toBe(260); // 2 x 130, ignores unitPrice 100
  });

  it("no live price -> falls back to amount x fallbackPrice", () => {
    const snap = buildManualSnapshot(
      "acc1",
      [tok({ amount: 3, fallbackPrice: 50 })],
      [undefined],
      TS,
    );
    expect(snap.balances[0].usdValue).toBe(150); // 3 x 50
  });

  it("selfPrice and metaJson always null (mark-to-market)", () => {
    const snap = buildManualSnapshot("acc1", [tok({})], [130], TS);
    expect(snap.balances[0].selfPrice).toBeNull();
    expect(snap.balances[0].metaJson).toBeNull();
  });

  it("totalUsd = sum of balance usdValue", () => {
    const snap = buildManualSnapshot(
      "acc1",
      [tok({ amount: 2 }), tok({ symbol: "ETH", amount: 5, fallbackPrice: 10 })],
      [130, undefined],
      TS,
    );
    // 2x130 + 5x10 = 260 + 50 = 310
    expect(snap.snapshot.totalUsd).toBe(310);
  });

  it("empty tokens -> empty balances, totalUsd 0", () => {
    const snap = buildManualSnapshot("acc1", [], [], TS);
    expect(snap.balances).toHaveLength(0);
    expect(snap.snapshot.totalUsd).toBe(0);
  });

  it("snapshot carries accountId and takenAt", () => {
    const snap = buildManualSnapshot("acc-x", [tok({})], [undefined], TS);
    expect(snap.snapshot.accountId).toBe("acc-x");
    expect(snap.snapshot.takenAt).toBe(TS);
  });
});

// Display unit price per holding: fiat via FX rate (live, not frozen), others via enrich price;
// either missing -> undefined (buildManualSnapshot then uses the user's own price).
//
// Fiat identity comes from `fiatRefs` by tokenId, not `CredsToken.ref`: in production that ref is
// the CGK namer's and always null for fiat. So these cases keep `CredsToken.ref` null on purpose.
describe("manualUnitPrices", () => {
  // Fake enrich result: price by tokenId, missing -> no price field.
  const enrich = (priceById: Record<string, number>): ReadonlyMap<string, TokenRecord> =>
    new Map(
      Object.entries(priceById).map(([id, unitPrice]) => [
        id,
        { id, price: { unitPrice, asOf: 0, stale: false } } as unknown as TokenRecord,
      ]),
    );
  // Fake fxResolve: USD always 1 (like the real FxRates.resolve); others from the table, else undefined.
  const fakeFx = (rates: Record<string, number> = {}) => {
    const asked: string[] = [];
    const resolve = (code: string) =>
      Effect.sync(() => {
        asked.push(code);
        const c = code.trim().toUpperCase();
        return Option.fromNullable(c === "USD" ? 1 : rates[c]);
      });
    return { resolve, asked };
  };
  // Fake manualFiatRefs output: tokenId -> fiat namer ref.
  const fiatRefs = (m: Record<string, string>): ReadonlyMap<string, string> =>
    new Map(Object.entries(m));

  // Production shape of a fiat holding: `ref` is null, identity comes from `fiatRefs`.
  const fiat = (over: Partial<CredsToken>): CredsToken =>
    tok({ id: "tk-USD", symbol: "USD", ref: null, ...over });

  it("fiat USD -> rate 1 (no enrich lookup; ref null, identity from fiatRefs)", async () => {
    const { resolve } = fakeFx();
    const prices = await runWithOracle(
      { fx: { resolve: resolve } },
      manualUnitPrices([fiat({})], enrich({}), fiatRefs({ "tk-USD": "fiat/issued:USD" })),
    );
    expect(prices).toEqual([1]);
  });

  // The key regression: ref null but tokenId in `fiatRefs` must still go through FX; keying on
  // `fiatCodeOf(t.ref)` would never fire in production.
  it("ref null but tokenId in the fiat map -> goes through FX (production shape)", async () => {
    const { resolve, asked } = fakeFx({ EUR: 1.1 });
    const prices = await runWithOracle(
      { fx: { resolve: resolve } },
      manualUnitPrices(
        [tok({ id: "tk-EUR", symbol: "EUR", ref: null })],
        enrich({}),
        fiatRefs({ "tk-EUR": "fiat/issued:EUR" }),
      ),
    );
    expect(prices).toEqual([1.1]);
    expect(asked).toEqual(["EUR"]);
  });

  it("non-fiat -> enrich price (fx untouched)", async () => {
    const { resolve, asked } = fakeFx();
    const prices = await runWithOracle(
      { fx: { resolve: resolve } },
      // not in the fiat map -> non-fiat
      manualUnitPrices(
        [tok({ id: "tk-BTC", symbol: "BTC", ref: "coingecko/issued:bitcoin" })],
        enrich({ "tk-BTC": 65000 }),
        fiatRefs({}),
      ),
    );
    expect(prices).toEqual([65000]);
    expect(asked).toEqual([]); // non-fiat never asks fx
  });

  it("fiat rate missing (cold cache) -> undefined (fall back to own price)", async () => {
    const { resolve } = fakeFx(); // EUR not in the table
    const prices = await runWithOracle(
      { fx: { resolve: resolve } },
      manualUnitPrices(
        [fiat({ id: "tk-EUR", symbol: "EUR" })],
        enrich({}),
        fiatRefs({ "tk-EUR": "fiat/issued:EUR" }),
      ),
    );
    expect(prices).toEqual([undefined]);
  });

  it("non-fiat without live price -> undefined (fall back to own price)", async () => {
    const { resolve } = fakeFx();
    const prices = await runWithOracle(
      { fx: { resolve: resolve } },
      manualUnitPrices([tok({ id: "tk-X", ref: "coingecko/issued:x" })], enrich({}), fiatRefs({})),
    );
    expect(prices).toEqual([undefined]);
  });

  it("tokenId not in the fiat map (custom token) -> treated as non-fiat via enrich", async () => {
    const { resolve, asked } = fakeFx({ USD: 1 });
    const prices = await runWithOracle(
      { fx: { resolve: resolve } },
      manualUnitPrices([tok({ id: "tk-c", ref: null })], enrich({}), fiatRefs({})),
    );
    expect(prices).toEqual([undefined]);
    expect(asked).toEqual([]);
  });

  it("bare symbol=USD but not in the fiat map -> not fiat (fiatRefs is authoritative)", async () => {
    const { resolve, asked } = fakeFx({ USD: 1 });
    const prices = await runWithOracle(
      { fx: { resolve: resolve } },
      // not in the map -> not short-circuited to 1 by fx
      manualUnitPrices(
        [tok({ id: "tk-usdcoin", symbol: "USD", ref: "coingecko/issued:some-usd-token" })],
        enrich({ "tk-usdcoin": 42 }),
        fiatRefs({}),
      ),
    );
    expect(prices).toEqual([42]); // via enrich
    expect(asked).toEqual([]);
  });

  it("fiat ref outside the allowlist in the map -> rejected by fiatCodeOf -> non-fiat via enrich", async () => {
    const { resolve, asked } = fakeFx({ USD: 1 });
    const prices = await runWithOracle(
      { fx: { resolve: resolve } },
      // XXX is not in SUPPORTED_CURRENCIES -> non-fiat
      manualUnitPrices(
        [tok({ id: "tk-xxx", symbol: "XXX", ref: null })],
        enrich({ "tk-xxx": 7 }),
        fiatRefs({ "tk-xxx": "fiat/issued:XXX" }),
      ),
    );
    expect(prices).toEqual([7]);
    expect(asked).toEqual([]);
  });

  it("several fiat holdings with the same code -> resolved once (deduped)", async () => {
    const { resolve, asked } = fakeFx({ EUR: 1.1 });
    const eur = (id: string) => tok({ id, symbol: "EUR", ref: null });
    const prices = await runWithOracle(
      { fx: { resolve: resolve } },
      manualUnitPrices(
        [eur("a"), eur("b")],
        enrich({}),
        fiatRefs({ a: "fiat/issued:EUR", b: "fiat/issued:EUR" }),
      ),
    );
    expect(prices).toEqual([1.1, 1.1]);
    expect(asked).toEqual(["EUR"]); // deduped: one code asked once
  });

  it("mixed fiat + non-fiat stay aligned in order", async () => {
    const { resolve } = fakeFx({ EUR: 1.1 });
    const prices = await runWithOracle(
      { fx: { resolve: resolve } },
      // USD -> 1, live 65000, 1.1
      manualUnitPrices(
        [
          fiat({}),
          tok({ id: "tk-BTC", ref: "coingecko/issued:bitcoin" }),
          fiat({ id: "tk-EUR", symbol: "EUR" }),
        ],
        enrich({ "tk-BTC": 65000 }),
        fiatRefs({ "tk-USD": "fiat/issued:USD", "tk-EUR": "fiat/issued:EUR" }),
      ),
    );
    expect(prices).toEqual([1, 65000, 1.1]);
  });
});

// Synthesized rows flow through the existing assembly: selfPrice=null marks to the live source price,
// falling back to the baked usdValue only when the source price is missing.
describe("synthesized manual rows mark to market via deriveLiveAccountTotals", () => {
  const account = () =>
    ({ id: "m1", label: "m1", connectorId: "manual", archivedAt: null }) as unknown as AccountSafe;
  // Enrichment map: BTC at 65000, nothing else priced; keyed by token id `tk-<SYMBOL>`.
  const enrichedOf = (priceById: Record<string, number>): Map<string, TokenRecord> =>
    new Map(
      ["tk-BTC"].map((id) => [
        id,
        {
          id,
          ref: "src/issued:bitcoin",
          symbol: id.replace("tk-", ""),
          name: id,
          infoStale: false,
          price:
            priceById[id] === undefined
              ? undefined
              : { unitPrice: priceById[id], asOf: 0, stale: false },
        } as TokenRecord,
      ]),
    );
  const enrichedWithBtc = enrichedOf({ "tk-BTC": 65000 });
  const enrichedNoPrice = enrichedOf({});

  // Manual account with 0.5 BTC. The price was baked into usdValue at inject time; rows carry
  // token_id so the live side resolves the same price. The two cases pin "found" and "not found".
  const byAccount = (bakedPrice?: number) =>
    new Map<string, SnapshotWithBalances>([
      [
        "m1",
        buildManualSnapshot(
          "m1",
          [
            {
              id: "tk-BTC",
              symbol: "BTC",
              amount: 0.5,
              fallbackPrice: 30000,
              ref: "src/issued:bitcoin",
            },
          ],
          [bakedPrice],
          TS,
        ),
      ],
    ]);

  it("baked live price is the final net value (0.5x65000)", () => {
    const totals = deriveLiveAccountTotals(
      [account()],
      byAccount(65000),
      enrichedWithBtc,
      "self-first",
    );
    expect(totals.get("m1")).toBe(32500);
  });

  // No source price (custom token) -> falls back to the baked usdValue, i.e. the user's own price.
  it("nothing priced at inject time either -> falls back to the token's own price (0.5x30000)", () => {
    const totals = deriveLiveAccountTotals([account()], byAccount(), enrichedNoPrice, "self-first");
    expect(totals.get("m1")).toBe(15000);
  });
});
