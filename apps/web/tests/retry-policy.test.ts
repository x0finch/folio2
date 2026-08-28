import { describe, expect, it, vi } from "vitest";
import { RETRY, withRetry } from "@/lib/queries/constants";

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
    vi.useRealTimers();
  });

  it("一直失败就试满次数再抛,不会无限打下去", async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    const result = withRetry(call, never).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBe("boom");
    expect(call).toHaveBeenCalledTimes(RETRY.attempts + 1);
    vi.useRealTimers();
  });

  it("控制流(会话过期要跳登录页)原样抛出,不当失败重试", async () => {
    const redirect = { isRedirect: true };
    const call = vi.fn().mockRejectedValue(redirect);
    await expect(withRetry(call, (e) => e === redirect)).rejects.toBe(redirect);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
