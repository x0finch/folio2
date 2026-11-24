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
  // Retry only retryable errors. Must precede passthrough: it pins the input type to ConnectorError.
  //
  // Keyed on `_tag` via `isRetryable`, so a new tag fails to compile instead of silently not retrying.
  Schedule.whileInput((e: ConnectorError) => isRetryable(e)),
  // Output becomes the input (the error) so Retry-After is visible next line.
  Schedule.passthrough,
  // Honour Retry-After when given, else exponential; both clamped to the per-wait cap.
  Schedule.modifyDelay((err, computed) => {
    const suggested = retryAfterOf(err);
    return Duration.min(
      Duration.millis(RETRY_MAX_MS),
      suggested !== undefined ? Duration.millis(suggested) : computed,
    );
  }),
  // Additive jitter (+0-200ms) so 6 concurrent 429s don't wake together; Effect's multiplicative jittered could undercut the base.
  Schedule.addDelay(() => Duration.millis(Math.random() * RETRY_BASE_MS)),
  Schedule.intersect(Schedule.recurs(RETRY_MAX_ATTEMPTS - 1)),
  // The tuple's second element is the retry count so far (0-based); +1 is the attempt.
  //
  // Re-check the predicate: the Schedule still emits the final output, and tapOutput can't tell "again" from "give up".
  Schedule.tapOutput(([err, recurrence]: readonly [ConnectorError, number]) =>
    isRetryable(err) && recurrence < RETRY_MAX_ATTEMPTS - 1
      ? Effect.logWarning("provider call retrying").pipe(
          Effect.annotateLogs({
            attempt: recurrence + 1,
            // Log `_tag`: it is the retry criterion itself.
            reason: err._tag,
            retryAfterMs: retryAfterOf(err),
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
    // Timeout maps to unreachable (retryable); timeoutFail keeps the error channel ConnectorError, unlike Effect.timeout.
    Effect.timeoutFail({
      duration: Duration.millis(FETCH_TIMEOUT_MS),
      onTimeout: () => new ConnectorUnavailableError({ message: "provider fetch timed out" }),
    }),
  );

// Only the fetch is retried; the snapshot write is not.
export const fetchBalancesWithRetry = (
  account: AccountSafe,
  stored: Record<string, string>,
): Effect.Effect<FetchOutcome, ConnectorError, BalanceSource | ProviderNeeds> =>
  Effect.retry(once(account, stored), retryPolicy);
