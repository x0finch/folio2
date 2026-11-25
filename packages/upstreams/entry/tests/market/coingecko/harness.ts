import type { UpstreamError } from "@folio/upstream-basic";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { connection, type Needs } from "../../../src/market/coingecko/upstream";
import { type HttpStub, httpStub, jsonResponse, runClient } from "../../../src/runtime/testing";

type Env = Readonly<Record<string, string>>;

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
const provide = <A, E>(effect: Effect.Effect<A, E, Needs>, env: Env) =>
  Effect.provide(effect, connection(env));

export const run = <A, E>(
  stub: Stub,
  effect: Effect.Effect<A, E, Needs>,
  env: Env = {},
): Promise<A> => runClient(stub.http, provide(effect, env), "none");

// Retry cases sleep between attempts and `TestClock` does not advance by itself: run in a fiber and repeatedly
// yield + advance one second until done. Asserts attempt counts, never wall-clock.
export const runDriven = <A, E>(
  stub: Stub,
  effect: Effect.Effect<A, E, Needs>,
  env: Env = {},
): Promise<A> =>
  runClient(
    stub.http,
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(provide(effect, env));
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
  effect: Effect.Effect<unknown, UpstreamError, Needs>,
  env: Env = {},
): Promise<UpstreamError> => run(stub, Effect.flip(effect), env);
