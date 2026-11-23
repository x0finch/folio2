import { Database, type DbRequest } from "@folio/db";
import { PLATFORM_TTL_MS } from "@folio/oracle-basic";
import { Effect, Option, Schema } from "effect";

// DeFi protocol -> logo URL. Lives in the app, not the oracle: the data comes from the user's own synced
// balance meta (no upstream, no network), stored in `user_cache` under `defi-logo:<protocol>`.
// TTL reuses the long platform tier; expired rows are still read and refreshed on the next sync.
// Writing is `record`, not `warm`: the caller supplies the data and nothing is fetched.
const key = (protocol: string) => `defi-logo:${protocol}`;

const decodeUrl = Schema.decodeUnknownOption(Schema.String);

// `none` when missing or not a string, so the caller falls back to initials.
export const readDefiLogo = (
  protocol: string,
): Effect.Effect<Option.Option<string>, never, Database | DbRequest> =>
  Effect.flatMap(Database, ({ cache }) =>
    Effect.map(cache.get(key(protocol)), (hit) =>
      Option.flatMap(hit, (entry) => decodeUrl(entry.value)),
    ),
  );

// Batch write-back (per-key round trips would turn one D1 call into N); the first logo per protocol wins.
// No negative caching: a miss means none.
export const recordDefiLogos = (
  entries: readonly { protocol: string; logo: string }[],
): Effect.Effect<void, never, Database | DbRequest> =>
  Effect.flatMap(Database, ({ cache }) => {
    const seen = new Map<string, string>();
    for (const e of entries) {
      if (e.logo && !seen.has(e.protocol)) seen.set(e.protocol, e.logo);
    }
    if (seen.size === 0) return Effect.void;
    return cache.putMany(
      [...seen].map(([protocol, logo]) => ({
        key: key(protocol),
        value: logo,
        ttlMs: PLATFORM_TTL_MS,
      })),
    );
  });
