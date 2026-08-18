import { describe, expect, it } from "vitest";
import { parseIdleTimeout, shouldLock } from "../src/lib/hooks/idle-lock";

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

// 超时偏好解析(#292)：localStorage 存的字符串 → 毫秒。核心测试缝；
// localStorage 读写 + 跨组件事件是薄壳，靠浏览器手测。
//
// **它只回答「多久」,不回答「要不要锁」**(#353):后者是独立的开关键 IDLE_LOCK_ENABLED_KEY。
// 所以这里没有 null 出口了 —— 任何认不出的值(含旧版兼作关闭的 "never")都落到默认档,
// 「不锁」由开关那层表达。
const DEFAULT_MS = 15 * 60_000;

describe("parseIdleTimeout", () => {
  it("分钟选项 → 毫秒", () => {
    expect(parseIdleTimeout("1")).toBe(60_000);
    expect(parseIdleTimeout("5")).toBe(300_000);
    expect(parseIdleTimeout("15")).toBe(900_000);
    expect(parseIdleTimeout("30")).toBe(1_800_000);
  });

  // 老用户 localStorage 里可能还留着 "never"。它落到默认档不会让人被误锁 —— 那些用户的开关键
  // 不存在,LockScreen 第一道门就把锁拦住了,与改版前行为一致。
  it("旧的 never → 默认档(不再表示「永不」)", () => {
    expect(parseIdleTimeout("never")).toBe(DEFAULT_MS);
  });

  it("缺失(null)→ 默认档", () => {
    expect(parseIdleTimeout(null)).toBe(DEFAULT_MS);
  });

  it("非法值 → 回落默认档", () => {
    expect(parseIdleTimeout("7")).toBe(DEFAULT_MS);
    expect(parseIdleTimeout("abc")).toBe(DEFAULT_MS);
    expect(parseIdleTimeout("")).toBe(DEFAULT_MS);
  });
});
