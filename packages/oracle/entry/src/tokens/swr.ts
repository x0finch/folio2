import type { UpstreamError } from "@folio/client-core";
import { Effect, Option } from "effect";

// SWR + degradation, only in this file: read local, judge stale, fetch, write back; upstream down serves the old value.
// Degradation catches `UpstreamError` by type and logs a line; other defects still blow up (no blanket try/catch).
// "Expired is not deleted, read with stale" is the whole layer's convention: serve the old value and flag it refreshable.
// The shape is an effect piped into the read, not callbacks in an options object, so what `fetch` can fail with stays in the type.
// Domain-neutral but lives in `tokens/`; `../fx` and `../platforms` use it too.

export const degradeTo =
  <A>(at: string, fallback: A) =>
  <R>(self: Effect.Effect<A, UpstreamError, R>): Effect.Effect<A, never, R> =>
    Effect.catchAll(self, (error) => Effect.as(logDegraded(at, error), fallback));

// Logs only tag / pathname / status; `where` deliberately carries no query, so no API key, signature or wallet address can appear.
// Exported separately because warm needs to carry "failed" back to the caller (`RefreshStaleReport.degraded`) after its own `Effect.either`.
export const logDegraded = (at: string, error: UpstreamError): Effect.Effect<void> =>
  Effect.logWarning("oracle: upstream fetch failed, serving local data").pipe(
    Effect.annotateLogs({
      at,
      upstream: error.upstream,
      error: error._tag,
      where: error.where,
      status: error.status,
    }),
  );

export interface Cached<A> {
  readonly value: A;
  readonly stale: boolean;
}

/** Fresh: return without touching upstream. Stale / miss: fetch and write back. Upstream failure serves the old value (or `none`), never drops data; `at` only goes to the log. */
export const swr =
  <A, RF, RW>(
    at: string,
    fetch: Effect.Effect<Option.Option<A>, UpstreamError, RF>,
    write: (value: A) => Effect.Effect<void, never, RW>,
  ) =>
  <RR>(
    read: Effect.Effect<Option.Option<Cached<A>>, never, RR>,
  ): Effect.Effect<Option.Option<A>, never, RR | RF | RW> =>
    Effect.gen(function* () {
      const hit = yield* read;
      if (Option.isSome(hit) && !hit.value.stale) return Option.some(hit.value.value);

      const fetched = yield* degradeTo(at, Option.none<A>())(fetch);
      if (Option.isNone(fetched)) return Option.map(hit, (h) => h.value);

      yield* write(fetched.value);
      return fetched;
    });
