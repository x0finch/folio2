import { FetchHttpClient, HttpClient } from "@effect/platform";
import { Effect, type Layer } from "effect";
import { constTrue } from "effect/Function";

// Disables the platform's built-in tracing. Its span records `url.full`/`url.query` (HMAC
// signatures, wallet addresses) and all request headers — its redaction list misses our cred
// headers (`X-MBX-APIKEY`, `OK-ACCESS-SIGN`, …) — and it injects `traceparent` into outbound
// requests. Set via FiberRef rather than wrapping the client so a differently provided
// `HttpClient` can't bypass it. Abort-on-interrupt still works with tracing disabled.
export const disableBuiltInTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.locally(effect, HttpClient.currentTracerDisabledWhen, constTrue);

export const FolioHttpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer;
