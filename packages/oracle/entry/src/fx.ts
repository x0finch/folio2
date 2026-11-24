import type { UpstreamError } from "@folio/client-core";
import type { CacheEntry, CacheStore, DbRequest, TokenPriceStore } from "@folio/db";
import { DatabaseForOracle } from "@folio/db";
import type { TokenPricePoint, TokenRef } from "@folio/oracle-basic";
import {
  dayBucketOf,
  FIAT_NAMER,
  FX_TTL_MS,
  MS_PER_DAY,
  SUPPORTED_CURRENCIES,
} from "@folio/oracle-basic";
import { FxUpstream, TokenUpstream } from "@folio/oracle-basic/ports";
import { tokenRef } from "@folio/oracle-ref";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { type DailyFillReport, fillDaily } from "./daily-fill";
import { degradeTo } from "./tokens/swr";

// Fx facade: current and historical rates in one service.
//   `resolve`    read current rate (soft expiry: always served, however old)
//   `warm`       write current rate (by TTL; fetch only when missing or expired)
//   `rateSeries` read historical daily rates (table only, zero network)
//   `fillDaily`  backfill historical daily rates (only the queue's `daily-prices` job calls it)
// Persistence differs: current rates live in per-user `user_cache` (`fx:<code>`, TTL 6h); historical rates go to the
// global `token_daily_prices` and never touch user_cache, so `TokenPriceStore` / `TokenUpstream` are used only by `fillDaily`.
// `fx` is the rate itself (`FxUpstream`, `FX_TTL_MS`, `fx:<code>` key); `fiat` treats a currency as a token
// (`FIAT_NAMER`, `fiat/issued:<CODE>`, `fiatSeed`).
const ALL_CODES = SUPPORTED_CURRENCIES.map((c) => c.code);

// Currency code normalisation shared by key building, the USD check and fiat ref lookup; a missed normalisation would
// stop `usd` short-circuiting to 1 and never being cached.
const norm = (code: string): string => code.trim().toUpperCase();

// Current-rate cache: keys `fx:<code>`; reads and writes are batched (upstream returns a dozen currencies at once). TTL 6h.

export const fxKey = (currency: string): string => `fx:${norm(currency)}`;

// Stored value is a bare number; an unreadable one (old shape / hand-edited) is a miss that heals by refetching.
const decodeNumber = Schema.decodeUnknownOption(Schema.Number);

export const readFx = (
  cache: CacheStore,
  currency: string,
): Effect.Effect<Option.Option<number>, never, DbRequest> =>
  Effect.map(cache.get(fxKey(currency)), (hit) =>
    Option.flatMap(hit, (entry) => decodeNumber(entry.value)),
  );

// Freshness for a batch (used by warm): missing keys are absent, hits carry stale.
const readFxFreshness = (
  cache: CacheStore,
  currencies: readonly string[],
): Effect.Effect<Map<string, CacheEntry>, never, DbRequest> => cache.getMany(currencies.map(fxKey));

// One batched write: a dozen keys in one batch.
export const writeFx = (
  cache: CacheStore,
  rates: readonly { currency: string; usdPerUnit: number }[],
): Effect.Effect<void, never, DbRequest> =>
  cache.putMany(
    rates.map((r) => ({ key: fxKey(r.currency), value: r.usdPerUnit, ttlMs: FX_TTL_MS })),
  );

// BTC/USD history leg (past days only): reads `coingecko/issued:bitcoin` from `token_daily_prices` first, fetches and persists
// what is missing. Returns a Map of all buckets it has.
// Takes resolved service objects so its `R` is empty and the "do not refetch" rule can be tested with fake ports.
export const btcUsdDaily = (
  prices: TokenPriceStore,
  upstream: TokenUpstream,
  btcRef: TokenRef,
  buckets: readonly number[],
): Effect.Effect<Map<number, number>, UpstreamError, DbRequest> =>
  Effect.gen(function* () {
    const cached = yield* prices.getDailyByRef(btcRef, buckets);
    const missing = buckets.filter((b) => !cached.has(b));
    if (missing.length === 0) return cached;

    const fromMs = Math.min(...buckets) * MS_PER_DAY;
    const toMs = Math.max(...buckets) * MS_PER_DAY + (MS_PER_DAY - 1);
    const fetched = new Map<number, number>();
    for (const pt of yield* upstream.fetchPriceSeries(btcRef, fromMs, toMs)) {
      if (pt.unitPrice > 0) fetched.set(dayBucketOf(pt.atMs), pt.unitPrice); // ascending: last point of the day wins
    }
    const wanted = new Set(buckets);
    const toPersist = [...fetched.entries()]
      .filter(([b]) => wanted.has(b) && !cached.has(b))
      .map(([dayBucket, unitPrice]) => ({ dayBucket, unitPrice }));
    if (toPersist.length > 0) yield* prices.putDailyByRef(btcRef, toPersist);

    const out = new Map(cached);
    for (const [b, v] of fetched) if (!out.has(b)) out.set(b, v);
    return out;
  });

// Per-day fiat usd_per_unit = BTC/USD@day / BTC/currency@day (pure). Days missing either leg, or with BTC/currency <= 0,
// are skipped so the fallback chain handles them rather than emit a garbage number. Exported for pure tests.
export function deriveFiatDaily(
  btcUsdByDay: ReadonlyMap<number, number>,
  btcCodeByDay: ReadonlyMap<number, number>,
  buckets: readonly number[],
): Map<number, number> {
  const out = new Map<number, number>();
  for (const b of buckets) {
    const usd = btcUsdByDay.get(b);
    const inCode = btcCodeByDay.get(b);
    if (usd != null && inCode != null && inCode > 0) out.set(b, usd / inCode);
  }
  return out;
}

// Service shape is derived from the `effect` return value; `.Default` is its layer.
export class FxService extends Context.Service<FxService>()("oracle/FxService", {
  make: Effect.gen(function* () {
    const { cache, tokenPrices: prices } = yield* DatabaseForOracle;
    const upstream = yield* FxUpstream;
    // Ports used only by the historical half (`rateSeries` / `fillDaily`): daily rates in `token_daily_prices`,
    // and the two BTC legs via `fetchPriceSeries(btcRef, …, vsCurrency)`.
    const priceUpstream = yield* TokenUpstream;
    // `btcRef` from `FxUpstream` is the bridge between fx and tokens (base of the BTC derivation).
    const { btcRef } = upstream;

    return {
      // usd per 1 unit of currency. USD is always 1 (no cache lookup); cache miss gives `none` (caller falls back to USD).
      resolve: (currency: string): Effect.Effect<Option.Option<number>, never, DbRequest> =>
        norm(currency) === "USD" ? Effect.succeed(Option.some(1)) : readFx(cache, currency),

      // Warm after sync / first currency switch; defaults to all supported currencies.
      warm: (currencies: readonly string[] = ALL_CODES): Effect.Effect<void, never, DbRequest> =>
        Effect.gen(function* () {
          // USD is not a target: it is always 1 and never cached, so including it would make "all fresh" never hold.
          const targets = [...new Set(currencies.map(norm))].filter((c) => c !== "USD");
          if (targets.length === 0) return;

          // One batched read: all targets present and fresh means nothing to do.
          const hits = yield* readFxFreshness(cache, targets);
          if (targets.every((c) => hits.get(fxKey(c))?.stale === false)) return;

          // One fetch gets everything: write the other supported currencies in the same batch so a later switch is warm.
          // Upstream down: log and write nothing (reads soft-expire and serve the old value).
          const fresh = yield* upstream
            .fetchRates()
            .pipe(
              Effect.map(Option.some<ReadonlyMap<string, number>>),
              degradeTo("fx.warm", Option.none<ReadonlyMap<string, number>>()),
            );
          if (Option.isNone(fresh)) return;
          yield* writeFx(
            cache,
            [...fresh.value]
              .filter(([code]) => norm(code) !== "USD")
              .map(([currency, usdPerUnit]) => ({ currency, usdPerUnit })),
          );
        }),

      // Per-day usd_per_unit for a currency over the range, like `resolve` but at that day's rate.
      // Read-only: past days from `token_daily_prices` (`fiat/issued:<CODE>`), today from the current-rate cache.
      // Missing days are absent from the result; the caller degrades. USD is always 1. Aligned to UTC day buckets.
      rateSeries: (
        code: string,
        fromMs: number,
        toMs: number,
      ): Effect.Effect<readonly TokenPricePoint[], never, DbRequest> =>
        Effect.gen(function* () {
          if (fromMs > toMs) return [];
          const CODE = norm(code);
          const todayB = dayBucketOf(yield* Clock.currentTimeMillis);
          const fromB = dayBucketOf(fromMs);
          const toB = dayBucketOf(toMs);
          const buckets: number[] = [];
          for (let b = fromB; b <= toB; b++) buckets.push(b);

          // USD is always 1: no lookup, no derivation.
          if (CODE === "USD") return buckets.map((b) => ({ atMs: b * MS_PER_DAY, unitPrice: 1 }));

          const daily = buckets.filter((b) => b !== todayB);
          const cached = yield* prices.getDailyByRef(tokenRef.issued(FIAT_NAMER, CODE), daily);
          const current = buckets.includes(todayB) ? yield* readFx(cache, CODE) : Option.none();
          const out: TokenPricePoint[] = [];
          for (const b of buckets) {
            const rate = b === todayB ? Option.getOrUndefined(current) : cached.get(b);
            if (typeof rate === "number") out.push({ atMs: b * MS_PER_DAY, unitPrice: rate });
          }
          return out;
        }),

      // Backfills daily rates from `fromMs` to yesterday into the table (the only upstream fetch path).
      // One window has two legs (BTC/currency + BTC/USD, the latter cache first): rate = latter / former, stored as `fiat/issued:<CODE>`.
      fillDaily: (
        code: string,
        fromMs: number,
        maxCalls: number,
      ): Effect.Effect<DailyFillReport, never, DbRequest> => {
        const CODE = norm(code);
        if (CODE === "USD") return Effect.succeed({ calls: 0, done: true, failed: false });
        const fiatRef = tokenRef.issued(FIAT_NAMER, CODE);
        return fillDaily(
          cache,
          fiatRef,
          {
            callsPerWindow: 2,
            read: (buckets) => prices.getDailyByRef(fiatRef, buckets),
            fetch: (fromB, toB) =>
              Effect.gen(function* () {
                const buckets: number[] = [];
                for (let b = fromB; b <= toB; b++) buckets.push(b);
                // The two legs run concurrently; either failing fails the window (logged, retried next run).
                const [series, btcUsd] = yield* Effect.all(
                  [
                    priceUpstream.fetchPriceSeries(
                      btcRef,
                      fromB * MS_PER_DAY,
                      (toB + 1) * MS_PER_DAY - 1,
                      CODE,
                    ),
                    btcUsdDaily(prices, priceUpstream, btcRef, buckets),
                  ],
                  { concurrency: 2 },
                );
                const btcCode = new Map<number, number>();
                for (const pt of series) {
                  if (pt.unitPrice > 0) btcCode.set(dayBucketOf(pt.atMs), pt.unitPrice);
                }
                return deriveFiatDaily(btcUsd, btcCode, buckets);
              }),
            write: (rows) => prices.putDailyByRef(fiatRef, rows),
          },
          fromMs,
          maxCalls,
          "fx.fillDaily",
        );
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
