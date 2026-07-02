import { describe, expect, it } from "vitest";
import { ProviderError, parseRetryAfter } from "../src/errors";

describe("ProviderError", () => {
  it("infers retryable from code; carries retryAfterMs when given", () => {
    expect(new ProviderError("RATE_LIMITED", "x").retryable).toBe(true);
    expect(new ProviderError("UPSTREAM_ERROR", "x").retryable).toBe(true);
    expect(new ProviderError("AUTH_FAILED", "x").retryable).toBe(false);
    expect(new ProviderError("INVALID_CREDENTIALS", "x").retryable).toBe(false);

    const e = new ProviderError("RATE_LIMITED", "x", { retryAfterMs: 1500 });
    expect(e.retryAfterMs).toBe(1500);
    expect(new ProviderError("RATE_LIMITED", "x").retryAfterMs).toBeUndefined();
  });
});

describe("parseRetryAfter", () => {
  it("parses numeric seconds → ms", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBeUndefined(); // 非正
    expect(parseRetryAfter("-1")).toBeUndefined();
  });

  it("returns undefined for missing/invalid", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });

  it("parses an HTTP-date in the future → positive ms", () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(3000);
  });
});
