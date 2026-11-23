import { describe, expect, it } from "vitest";
import {
  ConnectorAuthError,
  ConnectorFailure,
  ConnectorRateLimitError,
  ConnectorUnavailableError,
  fromProviderError,
  isRetryable,
  messageOf,
  retryAfterOf,
} from "../src/connector-error";
import { ProviderError } from "../src/errors";

describe("fromProviderError", () => {
  it("merges rejected and malformed credentials into one non-retryable auth class", () => {
    for (const code of ["AUTH_FAILED", "INVALID_CREDENTIALS"] as const) {
      const out = fromProviderError(new ProviderError(code, "bad key"));
      expect(out).toBeInstanceOf(ConnectorAuthError);
      expect(out.message).toBe("bad key");
      expect(isRetryable(out)).toBe(false);
    }
  });

  it("keeps auth as auth even with retryable: false", () => {
    const out = fromProviderError(new ProviderError("AUTH_FAILED", "x", { retryable: false }));
    expect(out._tag).toBe("ConnectorAuthError");
  });

  it("rate limit is retryable and carries the upstream's wait hint", () => {
    const out = fromProviderError(
      new ProviderError("RATE_LIMITED", "slow", { retryAfterMs: 1500 }),
    );
    expect(out).toBeInstanceOf(ConnectorRateLimitError);
    expect(isRetryable(out)).toBe(true);
    expect(retryAfterOf(out)).toBe(1500);
  });

  it("upstream failure is retryable with no wait hint", () => {
    const out = fromProviderError(new ProviderError("UPSTREAM_ERROR", "502"));
    expect(out).toBeInstanceOf(ConnectorUnavailableError);
    expect(isRetryable(out)).toBe(true);
    expect(retryAfterOf(out)).toBeUndefined();
  });

  it("demotes an upstream failure marked non-retryable (e.g. blockbook 400) to failure", () => {
    const out = fromProviderError(new ProviderError("UPSTREAM_ERROR", "400", { retryable: false }));
    expect(out).toBeInstanceOf(ConnectorFailure);
    expect(isRetryable(out)).toBe(false);
  });

  it("demotes a rate limit marked non-retryable to failure too", () => {
    const out = fromProviderError(new ProviderError("RATE_LIMITED", "q", { retryable: false }));
    expect(out._tag).toBe("ConnectorFailure");
    expect(retryAfterOf(out)).toBeUndefined();
  });

  it("parse error / unsupported → non-retryable failure", () => {
    for (const code of ["PARSE_ERROR", "UNSUPPORTED"] as const) {
      const out = fromProviderError(new ProviderError(code, "nope"));
      expect(out._tag).toBe("ConnectorFailure");
      expect(isRetryable(out)).toBe(false);
    }
  });

  it("treats any non-ProviderError (even with retryable: true) as failure, keeping the cause", () => {
    const duck = { code: "UPSTREAM_ERROR", retryable: true, message: "fake" };
    const out = fromProviderError(duck);
    expect(out._tag).toBe("ConnectorFailure");
    expect(out.cause).toBe(duck);
    expect(fromProviderError(new TypeError("boom")).message).toBe("boom");
  });
});

describe("messageOf", () => {
  it("uses Error.message, stringifies anything else", () => {
    expect(messageOf(new Error("e1"))).toBe("e1");
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf(42)).toBe("42");
  });
});
