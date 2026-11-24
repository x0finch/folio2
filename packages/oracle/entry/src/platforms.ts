import type { CacheStore, DbRequest } from "@folio/db";
import { DatabaseForOracle } from "@folio/db";
import type { PlatformMeta } from "@folio/oracle-basic";
import { PLATFORM_NEG_TTL_MS, PLATFORM_TTL_MS } from "@folio/oracle-basic";
import { PlatformUpstream } from "@folio/upstream-basic/ports";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { degradeTo } from "./tokens/swr";

// Platform (chain + venue) names and logos. `resolve` reads (zero network, soft expiry); `warm` writes (fetch only when expired).
// This module owns "what a platform displays as": `resolve` always returns a displayable name, whether uncached,
// unlisted upstream, or expired. Reads and writes use the cache's batch ops to avoid N D1 round trips.
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Fallback display name from the key alone: `evm:<id>` as is; otherwise the part after the colon capitalised (`manual` becomes "Manual").
function fallbackName(key: string): string {
  if (key.startsWith("evm:")) return key;
  const slug = key.slice(key.indexOf(":") + 1);
  return cap(slug || key);
}

// Cache side: keys `platform:<key>` in the per-user cache table (shape decoded via Schema, not `as`; unreadable heals by refetch).

export const platformKey = (key: string): string => `platform:${key}`;

// `name: null` is a negative cache entry (asked upstream, no such key); it must differ from "absent" or every warm refetches the whole chain table.
const PlatformEntryShape = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  logo: Schema.optional(Schema.String),
});
export type PlatformEntry = Schema.Schema.Type<typeof PlatformEntryShape>;
const decodePlatform = Schema.decodeUnknownOption(PlatformEntryShape);

// Read a batch. `{name: null}` (asked, upstream has none) differs from absent (never asked); `stale` lets warm decide to refetch while display always uses the old value.
export const readPlatforms = (
  cache: CacheStore,
  keys: readonly string[],
): Effect.Effect<Map<string, { entry: PlatformEntry; stale: boolean }>, never, DbRequest> =>
  Effect.map(cache.getMany(keys.map(platformKey)), (hits) => {
    const out = new Map<string, { entry: PlatformEntry; stale: boolean }>();
    for (const key of keys) {
      const hit = hits.get(platformKey(key));
      if (!hit) continue;
      const entry = decodePlatform(hit.value);
      if (Option.isNone(entry)) continue;
      out.set(key, { entry: entry.value, stale: hit.stale });
    }
    return out;
  });

// One batched write: hits get a long TTL (near-static), negatives a short one (new chains may be listed anytime).
export const writePlatforms = (
  cache: CacheStore,
  entries: readonly { key: string; entry: PlatformEntry }[],
): Effect.Effect<void, never, DbRequest> =>
  cache.putMany(
    entries.map(({ key, entry }) => ({
      key: platformKey(key),
      value: entry,
      ttlMs: entry.name === null ? PLATFORM_NEG_TTL_MS : PLATFORM_TTL_MS,
    })),
  );

// Service shape is derived from the `effect` return value; `.Default` is its layer.
export class PlatformService extends Context.Service<PlatformService>()("oracle/PlatformService", {
  make: Effect.gen(function* () {
    const { cache } = yield* DatabaseForOracle;
    const upstream = yield* PlatformUpstream;

    return {
      // Every key gets a display: real name on hit, else a key-derived fallback. No network, one read.
      resolve: (
        keys: readonly string[],
      ): Effect.Effect<Map<string, PlatformMeta>, never, DbRequest> =>
        Effect.gen(function* () {
          const unique = [...new Set(keys)];
          const out = new Map<string, PlatformMeta>();
          if (unique.length === 0) return out;

          const hits = yield* readPlatforms(cache, unique); // one read
          for (const key of unique) {
            const entry = hits.get(key)?.entry;
            // A null name (negative cache) takes the same fallback path as uncached.
            out.set(
              key,
              entry?.name != null
                ? { key, name: entry.name, logo: entry.logo }
                : { key, name: fallbackName(key) },
            );
          }
          return out;
        }),

      // After sync: if any key is missing or expired, fetch the whole chain table once and write just these keys in one batch.
      warm: (keys: readonly string[]): Effect.Effect<void, never, DbRequest> =>
        Effect.gen(function* () {
          const unique = [...new Set(keys)];
          if (unique.length === 0) return;

          const hits = yield* readPlatforms(cache, unique);
          const missing = unique.filter((k) => {
            const hit = hits.get(k);
            return hit === undefined || hit.stale;
          });
          if (missing.length === 0) return;

          // One fetch for everything (the upstream endpoint is the whole table).
          // Degrade to `none`, not an empty table: "upstream says none" must write a short negative cache, while
          // "upstream down" must never write, or a real chain would be recorded as nonexistent for a day.
          const chains = yield* upstream
            .fetchChains()
            .pipe(
              Effect.map(Option.some<readonly PlatformMeta[]>),
              degradeTo("platforms.warm", Option.none<readonly PlatformMeta[]>()),
            );
          if (Option.isNone(chains)) return;
          const byKey = new Map(chains.value.map((c) => [c.key, c]));

          // Write only the keys asked for (the cache is per-user, the whole table is pointless there); keys missing
          // from the table get a short negative entry so they do not force a refetch on every warm.
          yield* writePlatforms(
            cache,
            missing.map((key) => {
              const hit = byKey.get(key);
              return { key, entry: hit ? { name: hit.name, logo: hit.logo } : { name: null } };
            }),
          );
        }),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
