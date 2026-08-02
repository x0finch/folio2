import { describe, expect, it } from "vitest";
import { parseIdleTimeout, shouldLock } from "../src/lib/idle-lock";

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

// 超时偏好解析(#292)：localStorage 存的字符串 → 毫秒 / null(永不)。核心测试缝；
// localStorage 读写 + 跨组件事件是薄壳，靠浏览器手测。
describe("parseIdleTimeout", () => {
  it("分钟选项 → 毫秒", () => {
    expect(parseIdleTimeout("1")).toBe(60_000);
    expect(parseIdleTimeout("5")).toBe(300_000);
    expect(parseIdleTimeout("15")).toBe(900_000);
    expect(parseIdleTimeout("30")).toBe(1_800_000);
  });

  it("never → null(永不)", () => {
    expect(parseIdleTimeout("never")).toBeNull();
  });

  it("缺失(null)→ 默认永不(null)", () => {
    expect(parseIdleTimeout(null)).toBeNull();
  });

  it("非法值 → 回落默认永不(null)", () => {
    expect(parseIdleTimeout("7")).toBeNull();
    expect(parseIdleTimeout("abc")).toBeNull();
    expect(parseIdleTimeout("")).toBeNull();
  });
});
