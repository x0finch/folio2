import { isRetryable, type Outbound, retryAfterOf, type UpstreamError } from "@folio/client-core";
import { CoinGeckoClient, type CoinGeckoClientApi } from "@folio/coingecko-client";
import { Duration, Effect, Schedule } from "effect";
import { RETRY_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_WAIT_MS } from "./constants";

// Per-request retry policy and client access shared by the package.

// Retry attaches to a single request, not the whole method: a failed page 3 of `fetchMarkets` retries page 3 only.
const policy = Schedule.exponential(Duration.millis(RETRY_BASE_MS)).pipe(
  // Retry only retryable errors, and give up when upstream's suggested wait exceeds our cap
  // (this may sit on a user's write path; clamping to 2s would likely hit 429 again). Must precede passthrough,
  // which pins the input type to `UpstreamError`.
  Schedule.whileInput((e: UpstreamError) => {
    if (!isRetryable(e)) return false;
    const suggested = retryAfterOf(e);
    return suggested === undefined || suggested <= RETRY_MAX_WAIT_MS;
  }),
  // Map output to the input (the error itself) so the next step can read Retry-After.
  Schedule.passthrough,
  // Honour upstream's wait, else exponential; both clamped to the per-wait cap.
  Schedule.modifyDelay((err, computed) => {
    const suggested = retryAfterOf(err);
    return Duration.min(
      Duration.millis(RETRY_MAX_WAIT_MS),
      suggested !== undefined ? Duration.millis(suggested) : computed,
    );
  }),
  // Additive jitter (+0..baseMs) so callers sharing one key do not all wake on the same Retry-After and
  // collide again; Effect's multiplicative `jittered` could shorten the backoff below base.
  Schedule.addDelay(() => Duration.millis(Math.random() * RETRY_BASE_MS)),
  Schedule.intersect(Schedule.recurs(RETRY_ATTEMPTS - 1)),
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
