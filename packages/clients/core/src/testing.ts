import { HttpClient, HttpClientError, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, type Scope, TestContext } from "effect";
import { type RateLimitScope, RateLimitScopeOverride } from "./ratelimit";

// Shared test wiring for the clients. Not `@effect/vitest`: its stable release peers on vitest 3,
// and the vitest-4 beta requires effect 4.

export interface Seen {
  readonly request: HttpClientRequestLike;
}

export interface HttpClientRequestLike {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>; // case-insensitive reads
  readonly body: string | undefined;
}

// The platform lowercases header names; without this `headers["X-Api-Sign"]` reads undefined.
const caseInsensitive = (headers: Record<string, string>): Record<string, string> =>
  new Proxy(headers, {
    get: (target, key) =>
      typeof key === "string" ? target[key.toLowerCase()] : Reflect.get(target, key),
    has: (target, key) => (typeof key === "string" ? key.toLowerCase() in target : key in target),
  });

export interface HttpStub {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly calls: Seen[];
}

// Fakes the `HttpClient` service (not `fetch`), so signing headers, body and interruption go
// through the real path.
export function httpStub(
  reply: (request: HttpClientRequestLike, nth: number) => Response | Promise<Response>,
): HttpStub {
  const calls: Seen[] = [];
  const client = HttpClient.make((request, url) => {
    const seen: HttpClientRequestLike = {
      method: request.method,
      url,
      headers: caseInsensitive({ ...request.headers }),
      body:
        request.body._tag === "Uint8Array"
          ? new TextDecoder().decode(request.body.body)
          : undefined,
    };
    calls.push({ request: seen });
    // A throwing `reply` simulates a network failure: map it to `RequestError` (not a defect) so
    // failure classification stays testable.
    return Effect.tryPromise({
      try: async () => {
        const res = await reply(seen, calls.length - 1);
        return HttpClientResponse.fromWeb(request, res);
      },
      catch: (cause) => new HttpClientError.RequestError({ request, reason: "Transport", cause }),
    });
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), calls };
}

export const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

// Fake outbound + rate-limit scope + `TestClock`. Defaults to `memory`: the `isolated` cursor is
// module-level per key, so tests would leak quota into each other. Pass `"none"` for files that
// fire many requests: once the burst is spent, `memory` waits on a `TestClock` that never moves.
export const testLayer = (stub: HttpStub, gate: RateLimitScope = "memory") =>
  Layer.mergeAll(stub.layer, Layer.succeed(RateLimitScopeOverride, gate), TestContext.TestContext);

// Logs the full `Cause` on failure; `runPromise` alone only surfaces an opaque `FiberFailure`.
export const runClient = <A, E>(
  stub: HttpStub,
  effect: Effect.Effect<A, E, HttpClient.HttpClient | Scope.Scope>,
  gate?: RateLimitScope,
): Promise<A> =>
  effect.pipe(
    Effect.tapErrorCause((cause) => Effect.logError(cause)),
    Effect.scoped,
    Effect.provide(testLayer(stub, gate)),
    Effect.runPromise,
  );

// Process-wide default scope for tests that can't provide one (the code under test calls
// `runPromise` itself). `undefined` restores the production default.
export { setScopeDefaultForTests as setRateLimitScopeForTests } from "./ratelimit";

// Fills the `HttpClient` slot for code that must not use it; dies if called, so wiring mistakes
// can't pass silently.
export const noOutbound: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() =>
    Effect.die(
      new Error("noOutbound: this code path is not supposed to use the HttpClient service"),
    ),
  ),
);
