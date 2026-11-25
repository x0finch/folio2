import type { TokenPriceWrite, TokenRecordPrice, TokenRef } from "@folio/oracle-basic";
import { formatTokenRef } from "@folio/oracle-ref";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Clock, Effect, Option } from "effect";
import { chunk, type DbClient } from "../client";
import { tokenDailyPrices, tokenRefs, tokens } from "../schema";

// Token prices, per user. Current price lives on the token row (expired rows kept, read as stale);
// daily history lives in the global `token_daily_prices`, keyed by tokenRef: past days never
// change, so it's kept forever with no TTL.

// 3 bind params per row x 30 = 90, under D1's ~100-parameter limit.
const DAILY_ROWS_PER_STATEMENT = 30;

export const makeUserTokenPriceStore =
  (namer: string) => (client: DbClient["Service"], userId: string) => {
    // The token's ref under the current upstream (the daily-price key); none without a ref row.
    const upstreamRefOf = (tokenId: string): Effect.Effect<Option.Option<string>> =>
      Effect.map(
        client.query((db) =>
          db
            .select({ localName: tokenRefs.localName })
            .from(tokenRefs)
            .where(
              and(
                eq(tokenRefs.userId, userId),
                eq(tokenRefs.namer, namer),
                eq(tokenRefs.tokenId, tokenId),
              ),
            ),
        ),
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]?.localName), (localName) =>
            formatTokenRef({ namer, localName }),
          ),
      );

    const dailyByRef = (
      ref: string,
      dayBuckets: readonly number[],
    ): Effect.Effect<Map<number, number>> =>
      Effect.gen(function* () {
        const out = new Map<number, number>();
        if (dayBuckets.length === 0) return out;
        // 1 fixed bind + up to 90 day buckets per chunk, under D1's ~100-parameter limit.
        const parts = chunk([...new Set(dayBuckets)]).filter((p) => p.length > 0);
        const batches = yield* Effect.forEach(parts, (part) =>
          client.query((db) =>
            db
              .select({
                dayBucket: tokenDailyPrices.dayBucket,
                unitPrice: tokenDailyPrices.unitPrice,
              })
              .from(tokenDailyPrices)
              .where(
                and(eq(tokenDailyPrices.tokenRef, ref), inArray(tokenDailyPrices.dayBucket, part)),
              ),
          ),
        );
        for (const rows of batches) for (const r of rows) out.set(r.dayBucket, r.unitPrice);
        return out;
      });

    // Multi-row INSERT: a backfill window is ~365 rows, and one statement per row would eat much of the
    // free tier's 10ms CPU. Several statements go in one batch (one round trip, atomic).
    const writeDaily = (
      ref: string,
      prices: readonly { dayBucket: number; unitPrice: number }[],
    ): Effect.Effect<void> =>
      client.batch((db) =>
        chunk(prices, DAILY_ROWS_PER_STATEMENT)
          .filter((part) => part.length > 0)
          .map((part) =>
            db
              .insert(tokenDailyPrices)
              .values(
                part.map((p) => ({
                  tokenRef: ref,
                  dayBucket: p.dayBucket,
                  unitPrice: p.unitPrice,
                })),
              )
              .onConflictDoUpdate({
                target: [tokenDailyPrices.tokenRef, tokenDailyPrices.dayBucket],
                set: { unitPrice: sql`excluded.unit_price` },
              }),
          ),
      );

    return {
      /** Tokens without a price are absent; expired prices are still returned. */
      getAll: (): Effect.Effect<Map<string, TokenRecordPrice>> =>
        Effect.gen(function* () {
          const t = yield* Clock.currentTimeMillis;
          const rows = yield* client.query((db) =>
            db
              .select({
                id: tokens.id,
                unitPrice: tokens.unitPrice,
                change24h: tokens.change24h,
                marketCapRank: tokens.marketCapRank,
                priceAsOf: tokens.priceAsOf,
                priceExpiresAt: tokens.priceExpiresAt,
              })
              .from(tokens)
              .where(eq(tokens.userId, userId)),
          );
          const out = new Map<string, TokenRecordPrice>();
          for (const r of rows) {
            if (r.unitPrice == null || r.priceAsOf == null) continue; // no price yet
            out.set(r.id, {
              unitPrice: r.unitPrice,
              change24h: r.change24h ?? undefined,
              marketCapRank: r.marketCapRank ?? undefined,
              asOf: r.priceAsOf,
              stale: (r.priceExpiresAt ?? 0) <= t,
            });
          }
          return out;
        }),

      // Expired rows are returned as stale (SWR); tokens without a price are absent.
      getByIds: (ids: readonly string[]): Effect.Effect<Map<string, TokenRecordPrice>> =>
        Effect.gen(function* () {
          const out = new Map<string, TokenRecordPrice>();
          if (ids.length === 0) return out;
          const t = yield* Clock.currentTimeMillis;
          const parts = chunk([...new Set(ids)]).filter((p) => p.length > 0);
          const batches = yield* Effect.forEach(parts, (part) =>
            client.query((db) =>
              db
                .select({
                  id: tokens.id,
                  unitPrice: tokens.unitPrice,
                  change24h: tokens.change24h,
                  marketCapRank: tokens.marketCapRank,
                  priceAsOf: tokens.priceAsOf,
                  priceExpiresAt: tokens.priceExpiresAt,
                })
                .from(tokens)
                .where(and(eq(tokens.userId, userId), inArray(tokens.id, part))),
            ),
          );
          for (const rows of batches) {
            for (const r of rows) {
              if (r.unitPrice == null || r.priceAsOf == null) continue; // no price yet
              out.set(r.id, {
                unitPrice: r.unitPrice,
                change24h: r.change24h ?? undefined,
                marketCapRank: r.marketCapRank ?? undefined,
                asOf: r.priceAsOf,
                stale: (r.priceExpiresAt ?? 0) <= t,
              });
            }
          }
          return out;
        }),

      // One statement for the whole batch via a single JSON bind and `UPDATE ... FROM json_each(?)`:
      // per-row statements cost too much Worker CPU. Missing marketCapRank keeps the stored value
      // (the price feed has no rank). Duplicate ids are deduped keeping the last, since
      // `UPDATE ... FROM` picks an undefined row on multiple matches.
      put: (prices: readonly TokenPriceWrite[], ttlMs: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (prices.length === 0) return;
          const priceExpiresAt = (yield* Clock.currentTimeMillis) + ttlMs;
          const last = new Map<string, TokenPriceWrite>();
          for (const p of prices) last.set(p.tokenId, p);
          const rows = JSON.stringify(
            Array.from(last.values(), (p) => ({
              id: p.tokenId,
              p: p.unitPrice,
              c: p.change24h ?? null,
              r: p.marketCapRank ?? null,
              a: p.asOf,
            })),
          );
          yield* client.query((db) =>
            db.run(sql`
            update ${tokens} set
              unit_price = j.value ->> '$.p',
              change_24h = j.value ->> '$.c',
              market_cap_rank = coalesce(j.value ->> '$.r', ${tokens}.market_cap_rank),
              price_as_of = j.value ->> '$.a',
              price_expires_at = ${priceExpiresAt}
            from json_each(${rows}) as j
            where ${tokens}.user_id = ${userId} and ${tokens}.id = j.value ->> '$.id'`),
          );
        }),

      // Past UTC days are immutable, so stored forever with no TTL.
      getDaily: (
        tokenId: string,
        dayBuckets: readonly number[],
      ): Effect.Effect<Map<number, number>> =>
        Effect.gen(function* () {
          if (dayBuckets.length === 0) return new Map<number, number>();
          const ref = yield* upstreamRefOf(tokenId);
          // An unrecognised coin has no global key: empty, not an error.
          return Option.isNone(ref)
            ? new Map<number, number>()
            : yield* dailyByRef(ref.value, dayBuckets);
        }),

      putDaily: (
        tokenId: string,
        prices: readonly { dayBucket: number; unitPrice: number }[],
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (prices.length === 0) return;
          const ref = yield* upstreamRefOf(tokenId);
          if (Option.isNone(ref)) return; // unrecognised coin: no global key to write under
          yield* writeDaily(ref.value, prices);
        }),

      // Direct by ref, for fiat history: fiat refs and the BTC cross leg may have no per-user
      // `token_refs` row, so they're written straight to the global table.
      getDailyByRef: (
        ref: TokenRef,
        dayBuckets: readonly number[],
      ): Effect.Effect<Map<number, number>> => dailyByRef(ref, dayBuckets),

      putDailyByRef: (
        ref: TokenRef,
        prices: readonly { dayBucket: number; unitPrice: number }[],
      ): Effect.Effect<void> => (prices.length === 0 ? Effect.void : writeDaily(ref, prices)),
    };
  };
