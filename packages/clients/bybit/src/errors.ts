import {
  UpstreamAuthError,
  type UpstreamError,
  UpstreamParseError,
  UpstreamUnavailableError,
} from "@folio/client-core";
import { AUTH_ERROR_CODES, RET_CODE_OK } from "./constants";
import type { BybitEnvelope } from "./types";

export const UPSTREAM = "bybit";

// Business-level errors: HTTP 200 + retCode != 0 (the request "succeeded", the error is in the body). Classifying them is "reading how upstream
// speaks", so it is the client's job: the adapter should not know 10004 is a signature error. Credential / signature / permission retCodes give a
// credentials problem (retrying is useless); others are upstream's fault (retrying helps). Called in `Effect.flatMap` by the client's one `get()`.
export function retCodeError(body: unknown, where: string): UpstreamError | undefined {
  // Confirm it is an object first: a bare `null` (a legal 200 JSON) would throw a TypeError on `.retCode`, a defect that gives no lead. An unreadable shape is a parse failure.
  if (typeof body !== "object" || body === null) {
    return new UpstreamParseError({
      upstream: UPSTREAM,
      where,
      cause: "bybit: response was not an object",
    });
  }
  const envelope = body as BybitEnvelope;
  if (envelope.retCode === RET_CODE_OK) return undefined;
  const code = envelope.retCode ?? -1;
  // retCode is not put in `status`, which is the HTTP status; it goes with retMsg into `cause`, which carries a prefix saying what it is.
  const cause = `bybit retCode ${code}: ${envelope.retMsg || "unknown"}`;
  return AUTH_ERROR_CODES.has(code)
    ? new UpstreamAuthError({ upstream: UPSTREAM, where, cause })
    : new UpstreamUnavailableError({ upstream: UPSTREAM, where, cause });
}
