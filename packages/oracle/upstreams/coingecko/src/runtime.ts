import { isRetryable, type Outbound, retryAfterOf, type UpstreamError } from "@folio/client-core";
import { CoinGeckoClient, type CoinGeckoClientApi } from "@folio/coingecko-client";
import { Duration, Effect, Schedule } from "effect";
import { RETRY_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_WAIT_MS } from "./constants";

// Per-request retry policy and client access shared by the package.

// Retry attaches to a single request, not the whole method: a failed page 3 of `fetchMarkets` retries page 3 only.
const policy = Schedule.exponential(Duration.millis(RETRY_BASE_MS)).pipe(
  // Retry only retryable errors, and give up when upstream's suggested wait exceeds our cap
  // (this may sit on a user's write path; clamping to 2s would likely hit 429 again).
  Schedule.while(({ input }: Schedule.Metadata<Duration.Duration, UpstreamError>) => {
    if (!isRetryable(input)) return false;
    const suggested = retryAfterOf(input);
    return suggested === undefined || suggested <= RETRY_MAX_WAIT_MS;
  }),
  // Honour upstream's wait, else exponential; both clamped to the per-wait cap.
  Schedule.modifyDelay(({ input, duration }) => {
    const suggested = retryAfterOf(input);
    return Effect.succeed(
      Duration.min(
        Duration.millis(RETRY_MAX_WAIT_MS),
        suggested !== undefined ? Duration.millis(suggested) : duration,
      ),
    );
  }),
  // Additive jitter (+0..baseMs) so callers sharing one key do not all wake on the same Retry-After and
  // collide again; Effect's multiplicative `jittered` could shorten the backoff below base.
  Schedule.addDelay(() => Effect.sync(() => Duration.millis(Math.random() * RETRY_BASE_MS))),
  (backoff) => Schedule.max([backoff, Schedule.recurs(RETRY_ATTEMPTS - 1)]),
);

// One request plus retry; wrap every `client.xxx` call site.
export const req = <A>(
  effect: Effect.Effect<A, UpstreamError, Outbound>,
): Effect.Effect<A, UpstreamError, Outbound> => Effect.retry(effect, policy);

// Run against the client.
export const withClient = <A>(
  use: (client: CoinGeckoClientApi) => Effect.Effect<A, UpstreamError, Outbound>,
): Effect.Effect<A, UpstreamError, CoinGeckoClient | Outbound> =>
  Effect.flatMap(CoinGeckoClient, use);
