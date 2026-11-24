import {
  UpstreamAuthError,
  UpstreamBlockedError,
  type UpstreamError,
  UpstreamParseError,
  UpstreamRateLimitError,
  UpstreamRefusedError,
  UpstreamUnavailableError,
} from "@folio/upstream-basic";
import { Match } from "effect";
import type { HttpFailure, SigningFailure } from "./errors";

interface ClassifyOptions {
  readonly upstream: string;
}

// Upstream-specific reclassification (e.g. binance's 400 = rejected signature) happens at the
// client's exit via `catchTag`, not here.
export const classifyFailure =
  (options: ClassifyOptions) =>
  (failure: HttpFailure | SigningFailure): UpstreamError => {
    const { upstream } = options;
    // Signing failed: not a transport fault (as one it would burn retries and hide the cause).
    // `_tag` rather than `instanceof`, which would depend on a single module instance.
    if (failure._tag === "SigningFailure") {
      return new UpstreamAuthError({ upstream, where: failure.where, cause: failure.cause });
    }

    const { where, status, retryAfterMs, cause } = failure;
    const base = { upstream, where, status, cause };
    return Match.value(failure.kind).pipe(
      Match.when("auth", () => new UpstreamAuthError(base)),
      Match.when(
        "rate-limited",
        () => new UpstreamRateLimitError({ upstream, where, status, retryAfterMs }),
      ),
      Match.when("blocked", () => new UpstreamBlockedError(base)),
      Match.when("refused", () => new UpstreamRefusedError(base)),
      Match.when("parse", () => new UpstreamParseError(base)),
      Match.whenOr("network", "upstream", () => new UpstreamUnavailableError(base)),
      Match.exhaustive,
    );
  };
