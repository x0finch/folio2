import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import type { TokenOption } from "@/lib/core/token-model";
import { NAMER } from "@/lib/server/oracle";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// Edge cache (Workers Cache) for the catalogue / search endpoints, shared across users (no userId in the key): both
// are user-independent upstream data. Each user's catalogue still lives per-user in D1; Workers Cache is per datacenter.
// The key must include the source name: with a user-selectable source a source-less key
// would silently serve one vendor's catalogue to someone who chose another; the name would then come from that user's oracle.
// On `*.workers.dev` the whole cache is a silent no-op (Cloudflare applies the Cache API only on custom domains, see
// DEPLOY.md), so the catch logs never fire: debug `stored` without `hit` means it isn't working. The catch's warn
// is for real failures. Cache read/write failures never block: fall back to computing every time.
const reason = (err: unknown): string => (err instanceof Error ? err.message : "unknown");

export const SEARCH_CACHE_TTL_S = 300;
export const CATALOGUE_CACHE_TTL_S = 600;
const TOKEN_CACHE_NAME = "folio-token-search";

/**
 * Wraps the effect itself, not an async shell around it: `load` is an Effect, so read cache -> compute on miss ->
 * write back share one fiber with the upstream request (a Promise boundary would keep fetching after cancellation).
 * Cache failures are logged via `Effect.catchAll` and treated as a miss; `tryPromise` (not `promise`) so they aren't defects.
 */
export const edgeCached = <E, R>(
  path: string,
  ttlSeconds: number,
  load: Effect.Effect<TokenOption[], E, R>,
): Effect.Effect<TokenOption[], E, R> =>
  Effect.gen(function* () {
    // Only a name: the Cache API requires a URL, and nothing connects to this host.
    const key = new Request(`https://folio.internal/${NAMER}/${path}`);
    const op = path.split("?")[0]; // log the endpoint, never the search term
    const hit = yield* Effect.tryPromise(async () => {
      const cache = await caches.open(TOKEN_CACHE_NAME);
      const res = await cache.match(key);
      return res ? ((await res.json()) as TokenOption[]) : null;
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          tokenLog.warn("edge cache: read failed", { op, error: reason(err.error) });
          return null;
        }),
      ),
    );
    if (hit) {
      tokenLog.debug("edge cache: hit", { op });
      return hit;
    }

    const out = yield* load;
    yield* Effect.tryPromise(async () => {
      const cache = await caches.open(TOKEN_CACHE_NAME);
      await cache.put(
        key,
        new Response(JSON.stringify(out), {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${ttlSeconds}`,
          },
        }),
      );
      tokenLog.debug("edge cache: stored", { op });
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() =>
          tokenLog.warn("edge cache: write failed", { op, error: reason(err.error) }),
        ),
      ),
    );
    return out;
  });
