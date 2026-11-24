import { describe, expect, it } from "vitest";
import { HttpFailure, SigningFailure } from "../src/errors";
import {
  classifyFailure,
  isRetryable,
  retryAfterOf,
  UpstreamAuthError,
  UpstreamParseError,
  UpstreamRateLimitError,
  UpstreamUnavailableError,
} from "../src/upstream-error";

// Default classification, shared by every client; upstream quirks live in each client's `catchTag`.
const classify = classifyFailure({ upstream: "acme" });

const http = (fields: Partial<ConstructorParameters<typeof HttpFailure>[0]> = {}) =>
  new HttpFailure({ kind: "upstream", where: "/v1/t", ...fields });

describe("classifyFailure", () => {
  it("each transport kind lands in its class", () => {
    expect(classify(http({ kind: "auth", status: 401 }))._tag).toBe("UpstreamAuthError");
    expect(classify(http({ kind: "rate-limited", status: 429 }))._tag).toBe(
      "UpstreamRateLimitError",
    );
    expect(classify(http({ kind: "parse" }))._tag).toBe("UpstreamParseError");
    // Network failures and other non-2xx are one class to the consumer: upstream unavailable.
    expect(classify(http({ kind: "network" }))._tag).toBe("UpstreamUnavailableError");
    expect(classify(http({ kind: "upstream", status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("signing failure → auth problem, not a transport failure", () => {
    const err = classify(new SigningFailure({ where: "/v1/t", cause: "bad secret" }));
    expect(err._tag).toBe("UpstreamAuthError");
  });

  it("carries the upstream's Retry-After onto the error", () => {
    const err = classify(http({ kind: "rate-limited", status: 429, retryAfterMs: 7000 }));
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(7000);
  });

  it("every error carries `upstream`", () => {
    expect(classify(http()).upstream).toBe("acme");
    expect(classify(new SigningFailure({ where: "/v1/t" })).upstream).toBe("acme");
  });

  it("upstream quirks don't live here — 400 follows the default rule (unavailable)", () => {
    // binance reclassifies 400 at its own exit (pinned by its tests).
    expect(classify(http({ status: 400 }))._tag).toBe("UpstreamUnavailableError");
  });
});

describe("isRetryable", () => {
  const of = (upstream = "acme", where = "/v1/t") => ({ upstream, where });

  it("rate limited / unavailable → retryable", () => {
    expect(isRetryable(new UpstreamRateLimitError(of()))).toBe(true);
    expect(isRetryable(new UpstreamUnavailableError(of()))).toBe(true);
  });

  it("auth / parse → not retryable", () => {
    expect(isRetryable(new UpstreamAuthError(of()))).toBe(false);
    expect(isRetryable(new UpstreamParseError(of()))).toBe(false);
  });

  it("only rate-limit errors carry Retry-After", () => {
    expect(retryAfterOf(new UpstreamRateLimitError({ ...of(), retryAfterMs: 1500 }))).toBe(1500);
    expect(retryAfterOf(new UpstreamRateLimitError(of()))).toBeUndefined();
    expect(retryAfterOf(new UpstreamUnavailableError(of()))).toBeUndefined();
  });
});
