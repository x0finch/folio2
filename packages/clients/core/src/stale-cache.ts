import type { UpstreamError } from "@folio/upstream-basic";
import { Clock, Effect, Semaphore } from "effect";

// TTL cache for near-static data (chain slug → chainId) that falls back to the stale value when a
// refresh fails and coalesces concurrent misses into one fetch.
// Module-level state, not scoped: on Workers a scoped cache would reset every request. No reset —
// tests isolate via `scope`.
const buckets = new Map<string, unknown>();

export interface StaleTolerantCache<A> {
  readonly get: <R>(
    fetch: Effect.Effect<A, UpstreamError, R>,
  ) => Effect.Effect<A, UpstreamError, R>;
}

export interface StaleTolerantCacheOptions<A> {
  // Bucket identity is three separate parts (not one pre-joined key) so two upstreams can't
  // collide on a hand-built prefix.
  readonly upstream: string; // "zerion" / "rabby"
  readonly name: string; // e.g. "chains"
  readonly scope: string; // usually baseUrl
  readonly ttlMs: number;
  // Treat a fetched value as a miss (e.g. a 200 with an empty chain list, which would otherwise
  // poison a whole day). Default: never.
  readonly isEmpty?: (value: A) => boolean;
  // Error when there is no value at all.
  readonly onEmpty: () => UpstreamError;
}

export function staleTolerantCache<A>(
  options: StaleTolerantCacheOptions<A>,
): StaleTolerantCache<A> {
  const key = `${options.upstream}:${options.name}:${options.scope}`;
  const found = buckets.get(key);
  if (found) return found as StaleTolerantCache<A>;
  const created = makeCache(options);
  buckets.set(key, created);
  return created;
}

function makeCache<A>(options: StaleTolerantCacheOptions<A>): StaleTolerantCache<A> {
  // Serialized so concurrent misses share one fetch.
  const lock = Semaphore.makeUnsafe(1);
  const isEmpty = options.isEmpty ?? (() => false);
  let value: A | undefined;
  let fetchedAt = Number.NEGATIVE_INFINITY;

  return {
    get: (fetch) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (value !== undefined && now - fetchedAt < options.ttlMs) return value;

          const fresh = yield* Effect.result(fetch);
          if (fresh._tag === "Success" && !isEmpty(fresh.success)) {
            value = fresh.success;
            fetchedAt = now;
            return value;
          }

          if (value !== undefined) return value;

          // No value at all: surface the fetch error (keeps 429/401 semantics), else `onEmpty`.
          return yield* Effect.fail(fresh._tag === "Failure" ? fresh.failure : options.onEmpty());
        }),
      ),
  };
}
