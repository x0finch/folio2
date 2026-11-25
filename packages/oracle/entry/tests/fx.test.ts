import { FX_TTL_MS, MS_PER_DAY, SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { Duration, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { btcUsdDaily, deriveFiatDaily, FxService, fxKey, readFx, writeFx } from "../src/fx";
import { harness, now0, upstreamDown } from "./fakes";

// Four methods of the fx service: `resolve` / `warm` (current rate: soft-expiry reads, TTL writes),
// `rateSeries` (historical daily rates: table only, today reads the current rate) and `fillDaily` (BTC-derived backfill,
// only in the `daily-prices` job). Persistence stays two places: current rates touch only `user_cache`; historical rates go
// to the global `token_daily_prices` (user_cache holds only the attempted range).

const setup = (rates: Record<string, number> = {}) => harness({ rates });
const withFx = <A, E, R>(f: (fx: FxService["Service"]) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(FxService, f);

describe("resolve: read", () => {
  it("USD is always 1 and the cache is not queried", async () => {
    const h = setup();
    expect(await h.run(withFx((fx) => fx.resolve("USD")))).toEqual(Option.some(1));
    expect(h.cache.entries.size).toBe(0); // cache never touched
  });

  it("a hit is served; so is an expired one: a ten-minute-old rate beats no rate", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* fx.warm(["EUR"]);
        expect(yield* fx.resolve("EUR")).toEqual(Option.some(1.09));

        yield* TestClock.adjust(Duration.millis(FX_TTL_MS * 2)); // past the TTL: the entry turns stale
        expect(yield* fx.resolve("EUR")).toEqual(Option.some(1.09));
      }),
    );
  });

  it("not in cache: none (caller falls back to USD)", async () => {
    const h = setup();
    expect(await h.run(withFx((fx) => fx.resolve("JPY")))).toEqual(Option.none());
  });

  it("key normalisation: case and whitespace read the same entry", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* fx.warm(["EUR"]);
        expect(yield* fx.resolve("eur")).toEqual(Option.some(1.09));
        expect(yield* fx.resolve(" Eur ")).toEqual(Option.some(1.09));
      }),
    );
  });

  it("the USD short-circuit is normalised too: lowercase usd is always 1, no cache lookup", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        expect(yield* fx.resolve("usd")).toEqual(Option.some(1));
        expect(yield* fx.resolve(" Usd ")).toEqual(Option.some(1));
      }),
    );
    expect(h.cache.entries.size).toBe(0);
  });
});

describe("warm: write", () => {
  it("missing: fetches once and writes back; all fresh: zero requests", async () => {
    const h = setup({ USD: 1, EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* fx.warm(["USD", "EUR"]);
        expect(h.fxUpstream.fetches).toBe(1);
        expect(yield* fx.resolve("EUR")).toEqual(Option.some(1.09));

        yield* fx.warm(["USD", "EUR"]);
        expect(h.fxUpstream.fetches).toBe(1); // all fresh, no more egress
      }),
    );
  });

  it("expired: fetches again", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* fx.warm(["EUR"]);
        yield* TestClock.adjust(Duration.millis(FX_TTL_MS + 1));
        yield* fx.warm(["EUR"]);
        expect(h.fxUpstream.fetches).toBe(2);
      }),
    );
  });

  it("USD only: no target, no egress", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(withFx((fx) => fx.warm(["USD"])));
    expect(h.fxUpstream.fetches).toBe(0);
  });

  it('USD is excluded from the freshness check, or "all fresh" could never hold', async () => {
    const h = setup({ USD: 1, EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* fx.warm(["USD", "EUR"]);
        yield* fx.warm(["USD", "EUR"]);
        yield* fx.warm(["USD", "EUR"]);
      }),
    );
    expect(h.fxUpstream.fetches).toBe(1);
    expect(h.cache.entries.has("fx:USD")).toBe(false); // USD is never cached
  });

  it("the other currencies in one response are written too: a later switch finds them warm", async () => {
    const h = setup({ USD: 1, EUR: 1.09, JPY: 0.0067 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* fx.warm(["EUR"]); // only EUR named
        expect(yield* fx.resolve("JPY")).toEqual(Option.some(0.0067));
      }),
    );
    expect(h.fxUpstream.fetches).toBe(1);
  });

  it("writes back in one batch: a dozen currencies is one D1 call, not a dozen round trips", async () => {
    const h = setup(Object.fromEntries(SUPPORTED_CURRENCIES.map((c, i) => [c.code, i + 1])));
    await h.run(withFx((fx) => fx.warm()));
    expect(h.cache.writes).toBe(1);
  });

  it("the freshness check is also one batched read, not per-currency lookups", async () => {
    const h = setup({ EUR: 1.09, JPY: 0.0067 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* fx.warm(["EUR", "JPY"]);
        const before = h.cache.reads;

        yield* fx.warm(["EUR", "JPY"]); // all fresh: one read for the check
        expect(h.cache.reads - before).toBe(1);
      }),
    );
  });

  it("warms all supported currencies by default", async () => {
    const h = setup(Object.fromEntries(SUPPORTED_CURRENCIES.map((c, i) => [c.code, i + 1])));
    await h.run(withFx((fx) => fx.warm()));
    // Everything except USD was written.
    expect(h.cache.entries.size).toBe(SUPPORTED_CURRENCIES.length - 1);
  });

  it("a currency upstream does not list stays unavailable and no bad value is written", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* fx.warm(["EUR", "KRW"]);
        expect(yield* fx.resolve("KRW")).toEqual(Option.none());
      }),
    );
  });

  it("lowercase currencies are normalised too, else usd would neither short-circuit nor be cached and every warm refetches", async () => {
    const h = setup({ USD: 1, EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* fx.warm(["usd"]); // normalises to USD: no target
        expect(h.fxUpstream.fetches).toBe(0);

        yield* fx.warm(["eur"]);
        yield* fx.warm(["EUR"]); // the last write was fx:EUR: judged fresh now
        expect(h.fxUpstream.fetches).toBe(1);
      }),
    );
  });

  // Upstream failure degrades like other degradation points: log a line, write nothing; reads soft-expire and serve the old value.
  it("upstream down: logs a line, writes nothing, does not throw; the old value stays readable", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(withFx((fx) => fx.warm(["EUR"])));
    h.fxUpstream.fail = upstreamDown();

    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* TestClock.adjust(Duration.millis(FX_TTL_MS + 1));
        yield* fx.warm(["EUR"]);
        expect(yield* fx.resolve("EUR")).toEqual(Option.some(1.09)); // old value still there
      }),
    );
    expect(h.logs.some((l) => l.annotations.at === "fx.warm")).toBe(true);
  });
});

// Cache side (keys / shape / batching): these hit the read/write ports in `../src/fx` directly with fake ports (`R` is `never`).
describe("cache: keys, shape, batching", () => {
  it("key is `fx:<uppercase code>`, normalised where the key is built", async () => {
    const h = setup();
    await h.run(writeFx(h.cache, [{ currency: " eur ", usdPerUnit: 1.08 }]));

    expect([...h.cache.entries.keys()]).toEqual(["fx:EUR"]);
    expect(fxKey(" eur ")).toBe("fx:EUR");
  });

  it("reads back a number; miss gives none", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        yield* writeFx(h.cache, [{ currency: "EUR", usdPerUnit: 1.08 }]);
        expect(yield* readFx(h.cache, "eur")).toEqual(Option.some(1.08));
        expect(yield* readFx(h.cache, "JPY")).toEqual(Option.none());
      }),
    );
  });

  it("one batched write: per-key round trips would turn 1 D1 call into N", async () => {
    const h = setup();
    await h.run(
      writeFx(h.cache, [
        { currency: "EUR", usdPerUnit: 1.08 },
        { currency: "JPY", usdPerUnit: 0.0067 },
        { currency: "GBP", usdPerUnit: 1.27 },
      ]),
    );
    expect(h.cache.writes).toBe(1); // three currencies, one batch
  });

  // The cache may hold an older version's shape (or a hand edit): Schema-decoded, undecodable counts as absent and refetches.
  it("not a number (old shape / hand-edited): treated as absent, no bad value reaches the screen", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        yield* h.cache.put(fxKey("EUR"), "1.08", FX_TTL_MS);
        expect(yield* readFx(h.cache, "EUR")).toEqual(Option.none());
      }),
    );
  });
});

// Historical daily rates (`rateSeries` reads / `fillDaily` backfills): reads the table only; backfill derives from the two BTC legs.
const NOW = now0;
const TODAY = Math.floor(NOW / MS_PER_DAY);
const day = (offset: number): number => (TODAY + offset) * MS_PER_DAY;
const FIAT_EUR = "fiat/issued:EUR";
// Both fakes default to id "src", so btcRef and the token upstream's ref namespace line up (the legs fetch through it).
const BTC_REF = "src/issued:bitcoin";
// Fetch call shape recorded by the token upstream: `fetchPriceSeries:<ref>:<UPPERCASE VS>` (see fakeUpstream).
const legCall = (vs: string) => `fetchPriceSeries:${BTC_REF}:${vs}`;

// One BTC leg history point (atMs on a day-bucket start, aligned with the request range).
const btcLeg = (perDay: Record<number, number>) =>
  Object.entries(perDay).map(([b, unitPrice]) => ({ atMs: Number(b) * MS_PER_DAY, unitPrice }));

describe("derivation (pure): deriveFiatDaily", () => {
  it("usd_per_unit = BTC/USD divided by BTC/currency, per day", () => {
    const usd = new Map([
      [TODAY - 2, 120000],
      [TODAY - 1, 100000],
    ]);
    const eur = new Map([
      [TODAY - 2, 100000],
      [TODAY - 1, 100000],
    ]);
    expect(deriveFiatDaily(usd, eur, [TODAY - 2, TODAY - 1])).toEqual(
      new Map([
        [TODAY - 2, 1.2],
        [TODAY - 1, 1],
      ]),
    );
  });

  it("days missing either leg, or with BTC/currency <= 0, are skipped (no garbage numbers)", () => {
    const usd = new Map([
      [TODAY - 2, 120000],
      [TODAY - 1, 100000],
      [TODAY, 100000],
    ]);
    const eur = new Map([
      [TODAY - 2, 0], // divide by zero: skipped
      [TODAY - 1, 100000],
      // TODAY lacks the currency leg: skipped
    ]);
    expect(deriveFiatDaily(usd, eur, [TODAY - 2, TODAY - 1, TODAY])).toEqual(
      new Map([[TODAY - 1, 1]]),
    );
  });
});

describe("rateSeries: historical daily rates", () => {
  it("USD is always 1: one per day, no egress, no table access", async () => {
    const h = setup();
    expect(await h.run(withFx((fx) => fx.rateSeries("USD", day(-2), day(0))))).toEqual([
      { atMs: day(-2), unitPrice: 1 },
      { atMs: day(-1), unitPrice: 1 },
      { atMs: day(0), unitPrice: 1 },
    ]);
    expect(h.upstream.calls).toEqual([]);
    expect(h.prices.dailyByRef.size).toBe(0);
  });

  it("cached past days are used directly: no derivation, no egress", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* h.prices.putDailyByRef(FIAT_EUR, [
          { dayBucket: TODAY - 2, unitPrice: 1.2 },
          { dayBucket: TODAY - 1, unitPrice: 1.1 },
        ]);
        expect(yield* fx.rateSeries("EUR", day(-2), day(-1))).toEqual([
          { atMs: day(-2), unitPrice: 1.2 },
          { atMs: day(-1), unitPrice: 1.1 },
        ]);
        expect(h.upstream.calls).toEqual([]); // all cache hits, zero legs
      }),
    );
  });

  it("missing past days are absent from the result, with no derivation and no egress (backfill is `fillDaily`'s job)", async () => {
    const h = setup();
    h.upstream.seriesByVs.set("USD", btcLeg({ [TODAY - 1]: 100000 }));
    h.upstream.seriesByVs.set("EUR", btcLeg({ [TODAY - 1]: 100000 }));
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* h.prices.putDailyByRef(FIAT_EUR, [{ dayBucket: TODAY - 2, unitPrice: 1.15 }]);
        expect(yield* fx.rateSeries("EUR", day(-2), day(-1))).toEqual([
          { atMs: day(-2), unitPrice: 1.15 },
        ]);
      }),
    );
    expect(h.upstream.calls).toEqual([]);
  });

  it("today's bucket reads the current-rate cache, no egress, no daily-table write; no current rate means missing", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        expect(yield* fx.rateSeries("EUR", day(0), NOW)).toEqual([]);
        yield* fx.warm(["EUR"]);
        expect(yield* fx.rateSeries("EUR", day(0), NOW)).toEqual([
          { atMs: day(0), unitPrice: 1.09 },
        ]);
        expect(yield* h.prices.getDailyByRef(FIAT_EUR, [TODAY])).toEqual(new Map());
      }),
    );
    expect(h.upstream.calls).toEqual([]);
  });

  it("from > to: empty", async () => {
    const h = setup();
    expect(await h.run(withFx((fx) => fx.rateSeries("EUR", day(-1), day(-2))))).toEqual([]);
  });
});

describe("fillDaily: backfill historical daily rates (the fiat half of the `daily-prices` job)", () => {
  it("missing past days: derived from the two BTC legs and stored in token_daily_prices; one window costs 2 calls; a rerun has zero egress", async () => {
    const h = setup();
    h.upstream.seriesByVs.set(
      "USD",
      btcLeg({ [TODAY - 2]: 120000, [TODAY - 1]: 100000, [TODAY]: 1 }),
    );
    h.upstream.seriesByVs.set("EUR", btcLeg({ [TODAY - 2]: 100000, [TODAY - 1]: 100000 }));
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        expect(yield* fx.fillDaily("EUR", day(-2), 10)).toEqual({
          calls: 2,
          done: true,
          failed: false,
        });
        expect(yield* h.prices.getDailyByRef(FIAT_EUR, [TODAY - 2, TODAY - 1, TODAY])).toEqual(
          new Map([
            [TODAY - 2, 1.2],
            [TODAY - 1, 1],
          ]),
        );
        const before = h.upstream.calls.length;
        expect((yield* fx.fillDaily("EUR", day(-2), 10)).calls).toBe(0);
        expect(h.upstream.calls.length).toBe(before);
        // After the backfill the read path hits directly.
        expect(yield* fx.rateSeries("EUR", day(-2), day(-1))).toHaveLength(2);
      }),
    );
  });

  it("the BTC/USD leg prefers the existing cache: no refetch, only the currency leg", async () => {
    const h = setup();
    h.upstream.seriesByVs.set("EUR", btcLeg({ [TODAY - 2]: 100000, [TODAY - 1]: 100000 }));
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
        yield* h.prices.putDailyByRef(BTC_REF, [
          { dayBucket: TODAY - 2, unitPrice: 120000 },
          { dayBucket: TODAY - 1, unitPrice: 100000 },
        ]);
        yield* fx.fillDaily("EUR", day(-2), 10);
        expect(h.upstream.calls).toEqual([legCall("EUR")]);
      }),
    );
  });

  it("budget below one window (< 2 calls): no call, not done", async () => {
    const h = setup();
    expect(await h.run(withFx((fx) => fx.fillDaily("EUR", day(-2), 1)))).toEqual({
      calls: 0,
      done: false,
      failed: false,
    });
    expect(h.upstream.calls).toEqual([]);
  });

  it("upstream down: failed, one log line, no throw", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    expect((await h.run(withFx((fx) => fx.fillDaily("EUR", day(-2), 10)))).failed).toBe(true);
    expect(h.logs.some((l) => l.annotations.at === "fx.fillDaily")).toBe(true);
  });

  it("USD has nothing to do", async () => {
    const h = setup();
    expect((await h.run(withFx((fx) => fx.fillDaily("usd", day(-2), 10)))).calls).toBe(0);
    expect(h.upstream.calls).toEqual([]);
  });
});

// BTC/USD leg: prefers cache, never refetches. Tests the function directly: it takes resolved ports and `R` is `never`.
describe("BTC/USD leg: prefers cache, no refetch", () => {
  const leg = (h: ReturnType<typeof setup>, buckets: readonly number[]) =>
    h.run(btcUsdDaily(h.prices, h.upstream, BTC_REF, buckets));

  it("all hits in cache: zero requests", async () => {
    const h = setup();
    await h.run(
      h.prices.putDailyByRef(BTC_REF, [
        { dayBucket: TODAY - 2, unitPrice: 120000 },
        { dayBucket: TODAY - 1, unitPrice: 100000 },
      ]),
    );

    expect(await leg(h, [TODAY - 2, TODAY - 1])).toEqual(
      new Map([
        [TODAY - 2, 120000],
        [TODAY - 1, 100000],
      ]),
    );
    expect(h.upstream.calls).toEqual([]);
  });

  it("missing past days: fetched once and stored (also warms BTC holders)", async () => {
    const h = setup();
    h.upstream.seriesByVs.set("USD", btcLeg({ [TODAY - 2]: 120000, [TODAY - 1]: 100000 }));

    expect(await leg(h, [TODAY - 2, TODAY - 1])).toEqual(
      new Map([
        [TODAY - 2, 120000],
        [TODAY - 1, 100000],
      ]),
    );
    expect(h.upstream.calls).toEqual([legCall("USD")]); // once, not per day
    // Stored: the next round (and any BTC holder's history curve) hits directly.
    expect(h.prices.dailyByRef.get(BTC_REF)).toEqual(
      new Map([
        [TODAY - 2, 120000],
        [TODAY - 1, 100000],
      ]),
    );
  });

  it("the cached value wins: a different upstream number for the same day does not overwrite", async () => {
    const h = setup();
    h.upstream.seriesByVs.set("USD", btcLeg({ [TODAY - 2]: 99000, [TODAY - 1]: 111111 }));
    await h.run(h.prices.putDailyByRef(BTC_REF, [{ dayBucket: TODAY - 1, unitPrice: 100000 }]));

    // Past days are immutable: the stored value wins (upstream's 111111 is dropped).
    expect((await leg(h, [TODAY - 2, TODAY - 1])).get(TODAY - 1)).toBe(100000);
    expect(h.prices.dailyByRef.get(BTC_REF)?.get(TODAY - 1)).toBe(100000);
  });
});
