import type { UpstreamError } from "@folio/client-core";
import type { InvalidInput, NotFound } from "@folio/db";

// Failures a handler may surface, and the single mapping to a client-readable message.

/** What a handler's `E` may hold; the plain `Error` member covers not-yet-typed failures. */
export type AppError = UpstreamError | NotFound | InvalidInput | Error;

// Not `instanceof Error`: `Data.TaggedError` extends Error too. Upstream errors are the ones with an `upstream` field.
const isUpstream = (error: AppError): error is UpstreamError => "upstream" in error;

/**
 * Typed failure -> client-readable message. Upstream errors get a composed message (tag, pathname, status;
 * never query or credentials). `NotFound` / `InvalidInput` pass through unchanged: a new Error would drop
 * the `Effect.fn` handler name that Effect records on the error object itself.
 */
export const toError = (error: AppError): Error =>
  isUpstream(error)
    ? new Error(
        `${error.upstream} ${error._tag} on ${error.where}${
          error.status !== undefined ? ` (${error.status})` : ""
        }`,
        { cause: error },
      )
    : error;
