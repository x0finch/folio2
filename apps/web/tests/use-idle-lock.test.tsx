import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIdleLock } from "../src/lib/hooks/use-idle-lock";
import { useIdleTimeout } from "../src/lib/hooks/use-idle-timeout";

// useIdleLock 的主动定时器随超时改档重置(ADR 0029 / #291,回归)。纯判定在 idle-lock.test.ts,
// 这里盯的是 hook 的定时器壳 —— 手测漏过的那条:选「永不」却仍在旧档到点被锁。
// 用 fake timers 直接推进时钟,不产生任何活动事件(活动会顺带用新档重置,遮住 bug)。
describe("useIdleLock 定时器随 timeoutMs 改档重置", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("具体档到点 → 锁(基线)", () => {
    const { result } = renderHook(() => useIdleLock(60_000));
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.locked).toBe(true);
  });

  it("从具体档切「永不」后 → 旧定时器不再到点锁", () => {
    const { result, rerender } = renderHook(({ t }: { t: number | null }) => useIdleLock(t), {
      initialProps: { t: (5 * 60_000) as number | null },
    });
    expect(result.current.locked).toBe(false);

    rerender({ t: null }); // 改档为「永不」
    // 推进远超原 5 分钟档,且全程无活动事件:修好后应始终不锁。
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(result.current.locked).toBe(false);
  });

  it("从「永不」切具体档 → 按新档到点锁", () => {
    const { result, rerender } = renderHook(({ t }: { t: number | null }) => useIdleLock(t), {
      initialProps: { t: null as number | null },
    });
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(result.current.locked).toBe(false); // 永不:再久也不锁

    rerender({ t: 60_000 }); // 改档为 1 分钟
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.locked).toBe(true);
  });
});

// 「永不」端到端不误锁(回归)。默认档 = 永不(#292 后),且 useIdleTimeout 读到「永不」→ timeoutMs=null。
// 组合两个真实 hook(不注入假 timeoutMs)复现真实读路径:偏好=never + lastActive 陈旧 → 全程不锁;
// 具体档 + 陈旧 → 照常锁(别把真锁一起修没)。历史上这里漏过一条挂载即比对的误锁(见 git log)。
const LAST_ACTIVE_KEY = "folio_lock_last_active";
const TIMEOUT_KEY = "folio_lock_timeout";

describe("useIdleTimeout + useIdleLock 组合:永不不误锁", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  const mountComposed = () =>
    renderHook(() => {
      const { timeoutMs } = useIdleTimeout();
      return useIdleLock(timeoutMs);
    });

  it("偏好=永不 + lastActive 陈旧(30 分钟前)→ 全程不锁", () => {
    localStorage.setItem(TIMEOUT_KEY, "never");
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 30 * 60_000));
    const { result } = mountComposed();
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(result.current.locked).toBe(false); // 永不:再久也不锁
  });

  it("默认(未设偏好)+ lastActive 陈旧 → 不锁(默认 = 永不)", () => {
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 30 * 60_000));
    const { result } = mountComposed();
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(result.current.locked).toBe(false);
  });

  it("偏好=1 分钟 + lastActive 陈旧 → 照常锁(没把真锁一起修没)", () => {
    localStorage.setItem(TIMEOUT_KEY, "1");
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 30 * 60_000));
    const { result } = mountComposed();
    expect(result.current.locked).toBe(true);
  });
});
