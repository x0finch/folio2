import { afterEach, describe, expect, it, vi } from "vitest";
import { RETRY, shouldRetry, withRetry } from "@/lib/queries/constants";

// 假计时器一律在钩子里还原:写在用例体末尾的话,断言一失败就跳过,泄漏给同文件后面的用例。
afterEach(() => {
  vi.useRealTimers();
});

// 失败重试的语义(FOL-33 现场):以前一次失败就是终局 —— 页面数据全走 loader 的
// `ensureQueryData`,而它在 retry 未定义时会写死 `retry = false`;鉴权那次调用更是裸的。
// 这三条钉住的是「会再试、试够就抛、控制流不当失败」。
describe("withRetry", () => {
  const never = () => false;

  it("第一次就成功时不重试", async () => {
    const call = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(call, never)).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("失败后接着试,成功了就返回", async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("ok");
    const result = withRetry(call, never);
    await vi.advanceTimersByTimeAsync(RETRY.delay(0));
    await expect(result).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("一直失败就试满次数再抛,不会无限打下去", async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    const result = withRetry(call, never).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBe("boom");
    expect(call).toHaveBeenCalledTimes(RETRY.attempts + 1);
  });

  it("取消之后不再继续 —— 导航被丢弃时循环要停得下来", async () => {
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

// 判据本身:服务端一次都不试(CF Worker 只有 10ms CPU,拖不起),控制流不当失败。
// 这个测试文件跑在 node 环境(没有 `window`),所以「浏览器里」得就地扮出来。
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
  it("浏览器里没到次数上限就再试", () => {
    asBrowser(() => {
      expect(shouldRetry(0, new Error("boom"))).toBe(true);
      expect(shouldRetry(RETRY.attempts, new Error("boom"))).toBe(false);
      expect(shouldRetry(999, new Error("boom"), RETRY.forever)).toBe(true);
    });
  });

  it("服务端一次都不试 —— 免得把 10ms 的那趟请求拖上半分钟", () => {
    expect(shouldRetry(0, new Error("boom"), RETRY.forever)).toBe(false);
  });

  it("跳转(会话过期要去登录页)不当失败重试", () => {
    // isRedirect 认的是「带 options 的 Response」(react-router redirect.js)。
    const redirectLike = Object.assign(new Response(null, { status: 307 }), { options: {} });
    asBrowser(() => {
      expect(shouldRetry(0, redirectLike, RETRY.forever)).toBe(false);
    });
  });

  it("控制流(会话过期要跳登录页)原样抛出,不当失败重试", async () => {
    const redirect = { isRedirect: true };
    const call = vi.fn().mockRejectedValue(redirect);
    await expect(withRetry(call, (e) => e === redirect)).rejects.toBe(redirect);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
