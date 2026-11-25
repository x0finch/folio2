import { isRetryable, retryAfterOf, type UpstreamError } from "@folio/upstream-basic";
import { Context, Duration, Effect, Layer, Schedule } from "effect";
import { defineUpstream } from "../../runtime/define";
import type { Outbound } from "../../runtime/http";
import { FolioHttpClient } from "../../runtime/http-client";
import type { CoinGeckoCall } from "./api";
import {
  CG_BASE_FREE,
  CG_BASE_OVERRIDE,
  CG_BASE_PRO,
  CG_BURST,
  CG_CALLS_PER_MIN_DEMO,
  CG_CALLS_PER_MIN_KEYLESS,
  CG_CALLS_PER_MIN_PRO,
  COINGECKO_API_KEY,
  COINGECKO_PRO_API_KEY,
  HEADER_DEMO,
  HEADER_PRO,
  ID,
  PRO_HOST,
  RETRY_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_MAX_WAIT_MS,
  USER_AGENT,
} from "./constants";

// CG_BURST per window, from upstream's "calls per minute".
const burstWindow = (callsPerMin: number) =>
  Duration.millis((CG_BURST / (callsPerMin / 60)) * 1000);

export const coingecko = defineUpstream({
  id: ID,
  label: "CoinGecko",
  base: CG_BASE_FREE,
  baseOverride: CG_BASE_OVERRIDE,
  hosts: { [PRO_HOST]: { base: CG_BASE_PRO, baseOverride: CG_BASE_OVERRIDE } },
  optionalKeys: [COINGECKO_API_KEY, COINGECKO_PRO_API_KEY],
  userAgent: USER_AGENT,
  headers: (keys): Record<string, string> => {
    const pro = keys[COINGECKO_PRO_API_KEY];
    const demo = keys[COINGECKO_API_KEY];
    return {
      accept: "application/json",
      ...(pro ? { [HEADER_PRO]: pro } : demo ? { [HEADER_DEMO]: demo } : {}),
    };
  },
  // One key serves the whole deployment (warm, ref index, search, prices, history all spend it);
  // without one the quota is the egress IP's, a separate bucket.
  limits: {
    default: [
      {
        limit: CG_BURST,
        window: burstWindow(CG_CALLS_PER_MIN_PRO),
        scope: "key",
        when: COINGECKO_PRO_API_KEY,
      },
      { limit: CG_BURST, window: burstWindow(CG_CALLS_PER_MIN_DEMO), scope: "key", when: "keyed" },
      {
        limit: CG_BURST,
        window: burstWindow(CG_CALLS_PER_MIN_KEYLESS),
        scope: "egress",
        when: "keyless",
      },
    ],
  },
});

export class CoinGeckoConnection extends Context.Service<CoinGeckoConnection, CoinGeckoCall>()(
  "upstreams/CoinGeckoConnection",
) {}

export type Needs = CoinGeckoConnection | Outbound;

// Every key is optional, so connecting cannot fail.
export const connection = (
  env: Readonly<Record<string, unknown>>,
): Layer.Layer<CoinGeckoConnection> =>
  Layer.effect(CoinGeckoConnection, Effect.orDie(coingecko.connect(env)));

// Ports are `R = never`, so this package provides the connection and `HttpClient` itself.
export const transport = (env: Readonly<Record<string, unknown>>): Layer.Layer<Needs> =>
  Layer.merge(connection(env), FolioHttpClient);

// Captures the context at build time and provides it on exit, so implementations stay plain
// Effect (tests provide a fake `HttpClient`) while port methods stay clean.
export const closeOver: Effect.Effect<
  <A>(effect: Effect.Effect<A, UpstreamError, Needs>) => Effect.Effect<A, UpstreamError>,
  never,
  Needs
> = Effect.map(
  Effect.context<Needs>(),
  (ctx) =>
    <A>(effect: Effect.Effect<A, UpstreamError, Needs>): Effect.Effect<A, UpstreamError> =>
      Effect.provide(effect, ctx),
);

const policy = Schedule.exponential(Duration.millis(RETRY_BASE_MS)).pipe(
  // Give up when upstream's suggested wait exceeds the cap: clamping to it would likely hit 429 again.
  Schedule.while(({ input }: Schedule.Metadata<Duration.Duration, UpstreamError>) => {
    if (!isRetryable(input)) return false;
    const suggested = retryAfterOf(input);
    return suggested === undefined || suggested <= RETRY_MAX_WAIT_MS;
  }),
  Schedule.modifyDelay(({ input, duration }) => {
    const suggested = retryAfterOf(input);
    return Effect.succeed(
      Duration.min(
        Duration.millis(RETRY_MAX_WAIT_MS),
        suggested !== undefined ? Duration.millis(suggested) : duration,
      ),
    );
  }),
  // Additive jitter so callers sharing one key don't all wake on the same Retry-After; Effect's
  // multiplicative `jittered` could shorten the backoff below base.
  Schedule.addDelay(() => Effect.sync(() => Duration.millis(Math.random() * RETRY_BASE_MS))),
  (backoff) => Schedule.max([backoff, Schedule.recurs(RETRY_ATTEMPTS - 1)]),
);

// Retry attaches to one request, not a whole method: a failed page 3 retries page 3 only.
export const req = <A>(
  effect: Effect.Effect<A, UpstreamError, Outbound>,
): Effect.Effect<A, UpstreamError, Outbound> => Effect.retry(effect, policy);

export const withCall = <A>(
  use: (call: CoinGeckoCall) => Effect.Effect<A, UpstreamError, Outbound>,
): Effect.Effect<A, UpstreamError, Needs> => Effect.flatMap(CoinGeckoConnection, use);
