import { describe, expect, it } from "vitest";
import {
  isRetryable,
  retryAfterOf,
  UpstreamAuthError,
  UpstreamBlockedError,
  UpstreamParseError,
  UpstreamRateLimitError,
  UpstreamRefusedError,
  UpstreamUnavailableError,
} from "../src";

const at = { upstream: "acme", where: "/v1/t" };

describe("isRetryable", () => {
  it("rate limited / unavailable → retryable", () => {
    expect(isRetryable(new UpstreamRateLimitError(at))).toBe(true);
    expect(isRetryable(new UpstreamUnavailableError(at))).toBe(true);
  });

  it("auth / blocked / refused / parse → not retryable", () => {
    expect(isRetryable(new UpstreamAuthError(at))).toBe(false);
    expect(isRetryable(new UpstreamBlockedError(at))).toBe(false);
    expect(isRetryable(new UpstreamRefusedError(at))).toBe(false);
    expect(isRetryable(new UpstreamParseError(at))).toBe(false);
  });
});

describe("retryAfterOf", () => {
  it("only rate-limit errors carry Retry-After", () => {
    expect(retryAfterOf(new UpstreamRateLimitError({ ...at, retryAfterMs: 1500 }))).toBe(1500);
    expect(retryAfterOf(new UpstreamRateLimitError(at))).toBeUndefined();
    expect(retryAfterOf(new UpstreamUnavailableError(at))).toBeUndefined();
  });
});

describe("message", () => {
  it("names upstream, tier, pathname and status, and nothing from `cause`", () => {
    const e = new UpstreamRefusedError({ ...at, status: 400, cause: "secret-ish body" });
    expect(e.message).toBe("acme refused at /v1/t (400)");
    expect(new UpstreamRateLimitError(at).message).toBe("acme rate-limited at /v1/t");
    expect(e).toBeInstanceOf(Error);
  });
});
