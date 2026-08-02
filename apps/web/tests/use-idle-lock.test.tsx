import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIdleLock } from "../src/lib/hooks/use-idle-lock";

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
