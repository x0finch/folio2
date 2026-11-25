import type { CacheStore, DbRequest, TokenPriceStore, TokenStore } from "@folio/db";
import type { TokenPricePoint } from "@folio/oracle-basic";
import { dayBucketOf, MS_PER_DAY } from "@folio/oracle-basic";
import type { TokenUpstream } from "@folio/upstream-basic/ports";
import { Clock, Effect, Option } from "effect";
import { type DailyFillReport, fillDaily } from "../daily-fill";

// Historical daily prices, separate from `./price` because the criterion differs: past days are immutable (stored once),
// today's bucket is mutable.
//   `priceSeries` / `priceAt`  read-only: past days from `token_daily_prices`, today from the price table's current price; missing days are absent and the caller degrades.
//   `fillDaily`                the only upstream path: the queue's `daily-prices` job fills first-activity day to yesterday within budget (`../daily-fill`).
export interface TokenHistory {
  // Daily price series, zero network: past days only if in the table; today's bucket is the current price (however old; absent if none).
  priceSeries(
    tokenId: string,
    fromMs: number,
    toMs: number,
  ): Effect.Effect<readonly TokenPricePoint[], never, DbRequest>;
  // Price at a moment: the UTC day bucket containing atMs; `none` if that day has no data (caller degrades). Zero network.
  priceAt(tokenId: string, atMs: number): Effect.Effect<Option.Option<number>, never, DbRequest>;
  // Backfills daily prices from `fromMs` to yesterday, at most `maxCalls` upstream calls; no-op if upstream does not recognise the token.
  fillDaily(
    tokenId: string,
    fromMs: number,
    maxCalls: number,
  ): Effect.Effect<DailyFillReport, never, DbRequest>;
}

export const makeHistory = (
  store: TokenStore,
  prices: TokenPriceStore,
  cache: CacheStore,
  upstream: TokenUpstream,
): TokenHistory => {
  const priceSeries = (
    tokenId: string,
    fromMs: number,
    toMs: number,
  ): Effect.Effect<readonly TokenPricePoint[], never, DbRequest> =>
    Effect.gen(function* () {
      const info = yield* store.getById(tokenId);
      // Upstream does not recognise it yet: no history (this upstream only knows names it issued).
      const ref = Option.flatMap(info, (i) => Option.fromNullishOr(i.ref));
      if (Option.isNone(ref) || fromMs > toMs) return [];

      const todayB = dayBucketOf(yield* Clock.currentTimeMillis);
      const fromB = dayBucketOf(fromMs);
      const toB = dayBucketOf(toMs);
      const daily: number[] = []; // every bucket except today reads the daily table (past days; future buckets have no rows)
      for (let b = fromB; b <= toB; b++) if (b !== todayB) daily.push(b);
      const withToday = fromB <= todayB && todayB <= toB;

      const cached = yield* prices.getDaily(tokenId, daily);
      const current = withToday ? (yield* prices.getByIds([tokenId])).get(tokenId) : undefined;
      const out: TokenPricePoint[] = [];
      for (let b = fromB; b <= toB; b++) {
        const price = b === todayB ? current?.unitPrice : cached.get(b);
        if (typeof price === "number") out.push({ atMs: b * MS_PER_DAY, unitPrice: price });
      }
      return out;
    });

  return {
    priceSeries,

    // Only the last point of that day; reuse `priceSeries` rather than add another fetch path.
    priceAt: (tokenId, atMs) =>
      Effect.map(
        Effect.suspend(() => priceSeries(tokenId, dayBucketOf(atMs) * MS_PER_DAY, atMs)),
        (series) => Option.fromNullishOr(series.at(-1)?.unitPrice),
      ),

    fillDaily: (tokenId, fromMs, maxCalls) =>
      Effect.gen(function* () {
        const info = yield* store.getById(tokenId);
        const ref = Option.flatMap(info, (i) => Option.fromNullishOr(i.ref));
        if (Option.isNone(ref)) return { calls: 0, done: true, failed: false };
        return yield* fillDaily(
          cache,
          tokenId,
          {
            callsPerWindow: 1,
            read: (buckets) => prices.getDaily(tokenId, buckets),
            fetch: (fromB, toB) =>
              Effect.map(
                upstream.fetchPriceSeries(
                  ref.value,
                  fromB * MS_PER_DAY,
                  (toB + 1) * MS_PER_DAY - 1,
                ),
                (points) => {
                  const byDay = new Map<number, number>();
                  // ascending: last point of the day wins
                  for (const pt of points) byDay.set(dayBucketOf(pt.atMs), pt.unitPrice);
                  return byDay;
                },
              ),
            write: (rows) => prices.putDaily(tokenId, rows),
          },
          fromMs,
          maxCalls,
          "tokens.fillDaily",
        );
      }),
  };
};
