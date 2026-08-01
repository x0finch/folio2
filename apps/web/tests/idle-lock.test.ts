import { describe, expect, it } from "vitest";
import { shouldLock } from "../src/lib/idle-lock";

// 闲置锁判定(ADR 0029 / #291)：到点该不该锁。纯函数是核心测试缝；
// 活动监听 / 定时器 / localStorage 是薄壳，靠浏览器手测。
// timeoutMs = null 表示「永不」；now < lastActiveAt(时钟回拨)保守处理为不锁。
describe("shouldLock", () => {
  const active = 1_000_000; // lastActiveAt 基准
  const FIVE_MIN = 5 * 60 * 1000;

  it("刚活跃(elapsed 0)→ 不锁", () => {
    expect(shouldLock({ lastActiveAt: active, now: active, timeoutMs: FIVE_MIN })).toBe(false);
  });

  it("未到点(elapsed < timeout)→ 不锁", () => {
    expect(
      shouldLock({ lastActiveAt: active, now: active + FIVE_MIN - 1, timeoutMs: FIVE_MIN }),
    ).toBe(false);
  });

  it("刚好到点(elapsed == timeout)→ 锁", () => {
    expect(shouldLock({ lastActiveAt: active, now: active + FIVE_MIN, timeoutMs: FIVE_MIN })).toBe(
      true,
    );
  });

  it("已超时(elapsed > timeout)→ 锁", () => {
    expect(
      shouldLock({ lastActiveAt: active, now: active + 2 * FIVE_MIN, timeoutMs: FIVE_MIN }),
    ).toBe(true);
  });

  it("timeoutMs = null(永不)→ 超再久也不锁", () => {
    expect(
      shouldLock({ lastActiveAt: active, now: active + 999 * FIVE_MIN, timeoutMs: null }),
    ).toBe(false);
  });

  it("时钟回拨(now < lastActiveAt)→ 保守不锁", () => {
    expect(shouldLock({ lastActiveAt: active, now: active - 5000, timeoutMs: FIVE_MIN })).toBe(
      false,
    );
  });
});
