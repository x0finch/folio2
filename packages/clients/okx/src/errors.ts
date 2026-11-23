import {
  UpstreamAuthError,
  type UpstreamError,
  UpstreamParseError,
  UpstreamUnavailableError,
} from "@folio/client-core";
import { AUTH_ERROR_CODES, CODE_OK } from "./constants";
import type { OkxEnvelope } from "./types";

export const UPSTREAM = "okx";

// Business-level errors: HTTP 200 + code != "0" (a string, unlike Bybit's number). Classifying them is "reading how upstream speaks", so it is the client's job:
// the adapter should not know 50113 is a signature error. Unchecked, a 200 + 50113 would read as success with empty `data`, i.e. "balance is 0".
// Called in `Effect.flatMap` by the client's one `get()`, which all six endpoints go through.
export function codeError(body: unknown, where: string): UpstreamError | undefined {
  // Confirm it is an object first: a bare `null` (a legal 200 JSON) would throw a TypeError on `.code`, a defect that gives no lead. An unreadable shape is a parse failure.
  if (typeof body !== "object" || body === null) {
    return new UpstreamParseError({
      upstream: UPSTREAM,
      where,
      cause: "okx: response was not an object",
    });
  }
  const envelope = body as OkxEnvelope;
  if (envelope.code === CODE_OK) return undefined;
  const code = envelope.code ?? "?";
  // The business code is not put in `status`, which is the HTTP status; mixing them confuses log readers.
  const cause = `okx code ${code}: ${envelope.msg || "unknown"}`;
  return AUTH_ERROR_CODES.has(code)
    ? new UpstreamAuthError({ upstream: UPSTREAM, where, cause })
    : new UpstreamUnavailableError({ upstream: UPSTREAM, where, cause });
}
