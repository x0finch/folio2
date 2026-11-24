import { Effect, Layer } from "effect";
import { constTrue } from "effect/Function";
import { FetchHttpClient, HttpClient } from "effect/http";

// Disables the platform's built-in tracing. Its span records `url.full`/`url.query` (HMAC
// signatures, wallet addresses) and all request headers — its redaction list misses our cred
// headers (`X-MBX-APIKEY`, `OK-ACCESS-SIGN`, …) — and it injects `traceparent` into outbound
// requests. Set via a context reference rather than wrapping the client so a differently provided
// `HttpClient` can't bypass it. Abort-on-interrupt still works with tracing disabled.
export const disableBuiltInTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, HttpClient.TracerDisabledWhen, constTrue);

// Reads the global `fetch` at call time: the library's default captures it once, so a later
// reassignment (a test's `vi.spyOn(globalThis, "fetch")`) would never be seen.
const callTimeFetch: typeof globalThis.fetch = (input, init) => fetch(input, init);

export const FolioHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.merge(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.Fetch, callTimeFetch),
);
