import { UpstreamAuthError, type UpstreamError } from "@folio/upstream-basic";
import { Effect } from "effect";
import { SIGNED_REQUEST_REJECTED_STATUS } from "./constants";

export const UPSTREAM = "binance";

// HTTP 400 → auth problem, not retryable. Binance uses 400 for a rejected signed request (bad
// secret -1022, malformed key -2014); retrying re-sends bad creds, which binance treats as
// probing. Rare non-cred 400s (-1021 clock skew) are equally non-transient.
export const rejectedSignatureIsAuth = <A, R>(
  effect: Effect.Effect<A, UpstreamError, R>,
): Effect.Effect<A, UpstreamError, R> =>
  Effect.catchTag(effect, "UpstreamRefusedError", (failure) =>
    Effect.fail(
      failure.status === SIGNED_REQUEST_REJECTED_STATUS
        ? new UpstreamAuthError({
            upstream: UPSTREAM,
            where: failure.where,
            status: failure.status,
            cause: failure.cause,
          })
        : failure,
    ),
  );
