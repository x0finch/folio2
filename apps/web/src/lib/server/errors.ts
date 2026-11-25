import type { InvalidInput, NotFound } from "@folio/db";
import type { UpstreamError } from "@folio/upstream-basic";

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

const PRETTY_CAUSE = Symbol.for("folio/pretty-cause");

/** Attaches the full `Cause.pretty` to an error thrown out of the runtime; plain values pass through. */
export const withPrettyCause = (error: unknown, pretty: string): unknown => {
  if (typeof error === "object" && error !== null) {
    // Redefinable: the same error object can be rejected by the runtime more than once.
    const existing = Object.getOwnPropertyDescriptor(error, PRETTY_CAUSE);
    if (existing ? existing.configurable : Object.isExtensible(error)) {
      Object.defineProperty(error, PRETTY_CAUSE, {
        value: pretty,
        configurable: true,
        writable: true,
      });
    }
  }
  return error;
};

/** The full cause of an error rejected by the runtime, if it came from there. */
export const prettyCauseOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null
    ? (error as { [PRETTY_CAUSE]?: string })[PRETTY_CAUSE]
    : undefined;
