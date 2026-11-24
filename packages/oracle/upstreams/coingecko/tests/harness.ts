import type { Outbound, UpstreamError } from "@folio/client-core";
import { type HttpStub, httpStub, jsonResponse, runClient } from "@folio/client-core/testing";
import { CoinGeckoClient, type CoinGeckoConfig } from "@folio/coingecko-client";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

// Shared wiring for the adapter tests. Stubs the `HttpClient` service (not `globalThis.fetch`) so the real path
// is exercised and the endpoint and params the adapter asked for are pinned.
// Runs the adapter's Effect face, not the Promise wrapper, so fake transport, clock and rate-limit tiers can be provided.

export interface Call {
  readonly path: string;
  readonly query: URLSearchParams;
}

export interface Stub {
  readonly http: HttpStub;
  readonly calls: Call[];
}

// `reply` returns the body; exceptions: an `Error` is a sentinel whose message is the status code (default 429),
// and a `Response` is sent as-is (use it for headers such as `Retry-After`).
export const stubbing = (reply: (call: Call, nth: number) => unknown): Stub => {
  const calls: Call[] = [];
  const http = httpStub((request, nth) => {
    const call: Call = { path: request.url.pathname, query: request.url.searchParams };
    calls.push(call);
    const body = reply(call, nth);
    if (body instanceof Response) return body;
    if (body instanceof Error) return new Response(null, { status: Number(body.message) || 429 });
    return jsonResponse(body);
  });
  return { http, calls };
};

// Routes by path segment. Value is the body, or a function returning it (called per request).
export const routed = (routes: Record<string, unknown>): Stub =>
  stubbing((call) => {
    const key = Object.keys(routes).find((k) => call.path.includes(k));
    if (key === undefined) throw new Error(`unstubbed endpoint: ${call.path}`);
    const hit = routes[key];
    return typeof hit === "function" ? (hit as () => unknown)() : hit;
  });

// Rate-limit tier is `none`: these tests are not about rate limiting and one case often fires a dozen requests;
// the `memory` tier would wait after burst quota and `TestClock` never advances on its own.
const provide = <A, E>(
  effect: Effect.Effect<A, E, CoinGeckoClient | Outbound>,
  config: CoinGeckoConfig,
) => Effect.provide(effect, CoinGeckoClient.layer(config));

export const run = <A, E>(
  stub: Stub,
  effect: Effect.Effect<A, E, CoinGeckoClient | Outbound>,
  config: CoinGeckoConfig = {},
): Promise<A> => runClient(stub.http, provide(effect, config), "none");

// Retry cases sleep between attempts and `TestClock` does not advance by itself: run in a fiber and repeatedly
// yield + advance one second until done. Asserts attempt counts, never wall-clock.
export const runDriven = <A, E>(
  stub: Stub,
  effect: Effect.Effect<A, E, CoinGeckoClient | Outbound>,
  config: CoinGeckoConfig = {},
): Promise<A> =>
  runClient(
    stub.http,
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(provide(effect, config));
      for (let i = 0; i < 20; i++) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));
      }
      return yield* Fiber.join(fiber);
    }),
    "none",
  );

// Failure path yields the error value itself, not a `FiberFailure`.
export const failing = (
  stub: Stub,
  effect: Effect.Effect<unknown, UpstreamError, CoinGeckoClient | Outbound>,
  config: CoinGeckoConfig = {},
): Promise<UpstreamError> => run(stub, Effect.flip(effect), config);
