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

// 老 ProviderError → 四类 ConnectorError 的桥,以及「值不值得重试」的唯一答案。
// sync 的退避重试与加账户的探活都靠这里:归错一类,要么必败的账户白打三轮,要么凭据错被当成网络抖动。

describe("fromProviderError", () => {
  it("凭据被拒与凭据不成立合成一类 auth,不重试", () => {
    for (const code of ["AUTH_FAILED", "INVALID_CREDENTIALS"] as const) {
      const out = fromProviderError(new ProviderError(code, "bad key"));
      expect(out).toBeInstanceOf(ConnectorAuthError);
      expect(out.message).toBe("bad key");
      expect(isRetryable(out)).toBe(false);
    }
  });

  it("auth 即便带 retryable:false 也仍是 auth(不被降级成说不清的失败)", () => {
    const out = fromProviderError(new ProviderError("AUTH_FAILED", "x", { retryable: false }));
    expect(out._tag).toBe("ConnectorAuthError");
  });

  it("限流:可重试,并带上上游建议的等待时长", () => {
    const out = fromProviderError(
      new ProviderError("RATE_LIMITED", "slow", { retryAfterMs: 1500 }),
    );
    expect(out).toBeInstanceOf(ConnectorRateLimitError);
    expect(isRetryable(out)).toBe(true);
    expect(retryAfterOf(out)).toBe(1500);
  });

  it("上游故障:可重试,没有等待建议", () => {
    const out = fromProviderError(new ProviderError("UPSTREAM_ERROR", "502"));
    expect(out).toBeInstanceOf(ConnectorUnavailableError);
    expect(isRetryable(out)).toBe(true);
    expect(retryAfterOf(out)).toBeUndefined();
  });

  it("上游故障被显式标成不可重试(如 blockbook 的 400)→ 降成 failure,不重试", () => {
    const out = fromProviderError(new ProviderError("UPSTREAM_ERROR", "400", { retryable: false }));
    expect(out).toBeInstanceOf(ConnectorFailure);
    expect(isRetryable(out)).toBe(false);
  });

  it("限流被显式标成不可重试 → 同样降成 failure", () => {
    const out = fromProviderError(new ProviderError("RATE_LIMITED", "q", { retryable: false }));
    expect(out._tag).toBe("ConnectorFailure");
    expect(retryAfterOf(out)).toBeUndefined();
  });

  it("解析失败 / 不支持 → failure,不重试", () => {
    for (const code of ["PARSE_ERROR", "UNSUPPORTED"] as const) {
      const out = fromProviderError(new ProviderError(code, "nope"));
      expect(out._tag).toBe("ConnectorFailure");
      expect(isRetryable(out)).toBe(false);
    }
  });

  it("非 ProviderError(哪怕长得像、带 retryable:true)一律 failure,保留原始 cause", () => {
    const duck = { code: "UPSTREAM_ERROR", retryable: true, message: "fake" };
    const out = fromProviderError(duck);
    expect(out._tag).toBe("ConnectorFailure");
    expect(out.cause).toBe(duck);
    expect(fromProviderError(new TypeError("boom")).message).toBe("boom");
  });
});

describe("messageOf", () => {
  it("Error 取 message,其余转字符串", () => {
    expect(messageOf(new Error("e1"))).toBe("e1");
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf(42)).toBe("42");
  });
});
