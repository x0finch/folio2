import { and, eq, inArray } from "drizzle-orm";
import { Clock, Effect, Option } from "effect";
import { chunk, type DbClient } from "../client";
import type { Drizzle } from "../connect";
import { userCache } from "../schema";

// Per-user KV cache; values are JSON, opaque to db, and key shapes belong to the callers.
// Sync-round keys live in the same table but bypass this store: their writes are conditional on
// the round id, which `put` can't express.
// Expired rows are kept and read back as stale (SWR): callers decide whether to refresh.

export interface CacheWrite {
  key: string;
  value: unknown;
  ttlMs: number;
}

export interface CacheEntry {
  value: unknown;
  stale: boolean;
}

/** Values are serialized once up front, since batching is by byte size. */
interface Row {
  key: string;
  v: string;
  expiresAt: number;
}

const rowOf = (w: CacheWrite, now: number): Row => ({
  key: w.key,
  v: JSON.stringify(w.value),
  expiresAt: now + w.ttlMs,
});

// Shared by `put` and `putMany` so both write identical rows.
const upsert = (db: Drizzle, userId: string, { key, v, expiresAt }: Row) =>
  db
    .insert(userCache)
    .values({ userId, k: key, v, expiresAt })
    .onConflictDoUpdate({ target: [userCache.userId, userCache.k], set: { v, expiresAt } });

// Cheap safeguard for large values. The number is a deliberately low guess: the real D1 batch
// limit can't be measured locally (Miniflare isn't D1).
const BATCH_BYTES = 512 * 1024;

// A row over budget goes in its own batch (D1 rejects it if it must). Splitting loses
// atomicity, which is fine here: keys are independent SWR entries, so a half-written run breaks no
// invariant and the next warm-up converges.
const byBytes = (rows: readonly Row[]): Row[][] => {
  const parts: Row[][] = [];
  let part: Row[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = row.v.length + row.key.length;
    if (part.length > 0 && bytes + size > BATCH_BYTES) {
      parts.push(part);
      part = [];
      bytes = 0;
    }
    part.push(row);
    bytes += size;
  }
  if (part.length > 0) parts.push(part);
  return parts;
};

export const makeUserCacheStore = (client: DbClient, userId: string) => {
  // A corrupt value is treated as a miss: the next access refetches it instead of crashing the page.
  const decode = (row: { v: string; expiresAt: number }, now: number): CacheEntry | undefined => {
    try {
      return { value: JSON.parse(row.v), stale: row.expiresAt <= now };
    } catch {
      return undefined;
    }
  };

  return {
    /** Miss and corrupt value both yield `none`. */
    get: (key: string): Effect.Effect<Option.Option<CacheEntry>> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* client.query((db) =>
          db
            .select({ v: userCache.v, expiresAt: userCache.expiresAt })
            .from(userCache)
            .where(and(eq(userCache.userId, userId), eq(userCache.k, key))),
        );
        const row = rows[0];
        return Option.fromNullable(row ? decode(row, now) : undefined);
      }),

    /** Missing keys are absent from the result. */
    getMany: (keys: readonly string[]): Effect.Effect<Map<string, CacheEntry>> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const out = new Map<string, CacheEntry>();
        // Chunked (`IN` list is bound by D1's parameter limit), run sequentially.
        const parts = chunk([...new Set(keys)]).filter((p) => p.length > 0);
        const batches = yield* Effect.forEach(parts, (part) =>
          client.query((db) =>
            db
              .select({ k: userCache.k, v: userCache.v, expiresAt: userCache.expiresAt })
              .from(userCache)
              .where(and(eq(userCache.userId, userId), inArray(userCache.k, part))),
          ),
        );
        for (const rows of batches) {
          for (const row of rows) {
            const entry = decode(row, now);
            if (entry) out.set(row.k, entry);
          }
        }
        return out;
      }),

    put: (key: string, value: unknown, ttlMs: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* client.query((db) => upsert(db, userId, rowOf({ key, value, ttlMs }, now)));
      }),

    /** One D1 batch (its only atomic multi-write), split sequentially only above `BATCH_BYTES`. */
    putMany: (writes: readonly CacheWrite[]): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const parts = byBytes(writes.map((w) => rowOf(w, now)));
        yield* Effect.forEach(parts, (part) =>
          client.batch((db) => part.map((row) => upsert(db, userId, row))),
        );
      }),
  };
};
