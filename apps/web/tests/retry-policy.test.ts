import { afterEach, describe, expect, it, vi } from "vitest";
import { RETRY, shouldRetry, withRetry } from "@/lib/queries/constants";

afterEach(() => {
  vi.useRealTimers();
});

describe("withRetry", () => {
  const never = () => false;

  it("no retry when the first attempt succeeds", async () => {
    const call = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(call, never)).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure, returns once it succeeds", async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("ok");
    const result = withRetry(call, never);
    await vi.advanceTimersByTimeAsync(RETRY.delay(0));
    await expect(result).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("keeps failing: retries to the limit then throws, never loops forever", async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    const result = withRetry(call, never).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBe("boom");
    expect(call).toHaveBeenCalledTimes(RETRY.attempts + 1);
  });

  it("stops after cancellation: the loop must be stoppable when navigation is discarded", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    const result = withRetry(call, never, RETRY.forever, controller.signal).catch(() => "stopped");
    await vi.advanceTimersByTimeAsync(RETRY.delay(0));
    const before = call.mock.calls.length;
    controller.abort();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(result).resolves.toBe("stopped");
    expect(call).toHaveBeenCalledTimes(before);
  });
});

function asBrowser<T>(body: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  try {
    return body();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

describe("shouldRetry", () => {
  it("in the browser retries until the attempt limit", () => {
    asBrowser(() => {
      expect(shouldRetry(0, new Error("boom"))).toBe(true);
      expect(shouldRetry(RETRY.attempts, new Error("boom"))).toBe(false);
      expect(shouldRetry(999, new Error("boom"), RETRY.forever)).toBe(true);
    });
  });

  it("on the server never retries, so a 10ms request is not dragged out for half a minute", () => {
    expect(shouldRetry(0, new Error("boom"), RETRY.forever)).toBe(false);
  });

  it("redirects (expired session must go to the login page) are not retried as failures", () => {
    const redirectLike = Object.assign(new Response(null, { status: 307 }), { options: {} });
    asBrowser(() => {
      expect(shouldRetry(0, redirectLike, RETRY.forever)).toBe(false);
    });
  });

  it("control flow (expired session must go to the login page) is rethrown as is, not retried as a failure", async () => {
    const redirect = { isRedirect: true };
    const call = vi.fn().mockRejectedValue(redirect);
    await expect(withRetry(call, (e) => e === redirect)).rejects.toBe(redirect);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
