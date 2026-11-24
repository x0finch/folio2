import {
  type ConnectorError,
  ConnectorUnavailableError,
  isRetryable,
  type ProviderNeeds,
  retryAfterOf,
} from "@folio/connectors-basic";
import type { AccountSafe } from "@folio/db";
import { Duration, Effect, Schedule } from "effect";
import { FETCH_TIMEOUT_MS, RETRY_BASE_MS, RETRY_MAX_ATTEMPTS, RETRY_MAX_MS } from "./constants";
import { BalanceSource } from "./services";
import type { FetchOutcome } from "./types";

const retryPolicy = Schedule.exponential(Duration.millis(RETRY_BASE_MS)).pipe(
  // Retry only retryable errors. Keyed on `_tag` via `isRetryable`, so a new tag fails to compile
  // instead of silently not retrying.
  Schedule.while(({ input }: Schedule.Metadata<Duration.Duration, ConnectorError>) =>
    isRetryable(input),
  ),
  // Honour Retry-After when given, else exponential; both clamped to the per-wait cap.
  Schedule.modifyDelay(({ input, duration }) => {
    const suggested = retryAfterOf(input);
    return Effect.succeed(
      Duration.min(
        Duration.millis(RETRY_MAX_MS),
        suggested !== undefined ? Duration.millis(suggested) : duration,
      ),
    );
  }),
  // Additive jitter (+0-200ms) so 6 concurrent 429s don't wake together; Effect's multiplicative jittered could undercut the base.
  Schedule.addDelay(() => Effect.sync(() => Duration.millis(Math.random() * RETRY_BASE_MS))),
  (backoff) => Schedule.max([backoff, Schedule.recurs(RETRY_MAX_ATTEMPTS - 1)]),
  // `attempt` counts retries from 1. Re-check the predicate: the schedule still emits on the step
  // that gives up, and tap can't tell "again" from "give up".
  Schedule.tap(({ input, attempt }: Schedule.Metadata<Duration.Duration, ConnectorError>) =>
    isRetryable(input) && attempt < RETRY_MAX_ATTEMPTS
      ? Effect.logWarning("provider call retrying").pipe(
          Effect.annotateLogs({
            attempt,
            // Log `_tag`: it is the retry criterion itself.
            reason: input._tag,
            retryAfterMs: retryAfterOf(input),
          }),
        )
      : Effect.void,
  ),
);

const once = (
  account: AccountSafe,
  stored: Record<string, string>,
): Effect.Effect<FetchOutcome, ConnectorError, BalanceSource | ProviderNeeds> =>
  Effect.flatMap(BalanceSource, (source) => source.fetch(account, stored)).pipe(
    // Timeout maps to unreachable (retryable), keeping the error channel ConnectorError.
    Effect.timeoutOrElse({
      duration: Duration.millis(FETCH_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(new ConnectorUnavailableError({ message: "provider fetch timed out" })),
    }),
  );

// Only the fetch is retried; the snapshot write is not.
export const fetchBalancesWithRetry = (
  account: AccountSafe,
  stored: Record<string, string>,
): Effect.Effect<FetchOutcome, ConnectorError, BalanceSource | ProviderNeeds> =>
  Effect.retry(once(account, stored), retryPolicy);
