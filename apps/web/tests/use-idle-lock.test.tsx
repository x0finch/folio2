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

// 「关着不误锁」端到端(回归)。#353 之后「不锁」由**独立的开关键**表达,不再是 timeout 的 "never"
// 档;默认仍是关。组合两个真实 hook(不注入假 timeoutMs)复现 LockScreen 的真实读路径 —— 开关关着
// 就压根不挂 useIdleLock,这里以传 null 等效表达。历史上这里漏过一条挂载即比对的误锁(见 git log)。
const LAST_ACTIVE_KEY = "folio_lock_last_active";
const TIMEOUT_KEY = "folio_lock_timeout";
const ENABLED_KEY = "folio_lock_enabled";

describe("useIdleTimeout + useIdleLock 组合:开关关着不误锁", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  const mountComposed = () =>
    renderHook(() => {
      const { timeoutMs, enabled } = useIdleTimeout();
      return useIdleLock(enabled ? timeoutMs : null);
    });

  it("开关关着 + lastActive 陈旧(30 分钟前)→ 全程不锁", () => {
    localStorage.setItem(TIMEOUT_KEY, "1"); // 时长偏好留着(关掉不该清它)
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 30 * 60_000));
    const { result } = mountComposed();
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(result.current.locked).toBe(false); // 关着:再久也不锁
  });

  it("默认(什么都没设)+ lastActive 陈旧 → 不锁(默认关)", () => {
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 30 * 60_000));
    const { result } = mountComposed();
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(result.current.locked).toBe(false);
  });

  // 老用户 localStorage 里残留的 "never" 现在会解析成默认档 —— 但开关键不存在,所以照旧不锁。
  it("残留的旧 never 值 + 开关未设 → 仍不锁(兼容)", () => {
    localStorage.setItem(TIMEOUT_KEY, "never");
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 30 * 60_000));
    const { result } = mountComposed();
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(result.current.locked).toBe(false);
  });

  it("开关开着 + 1 分钟 + lastActive 陈旧 → 照常锁(没把真锁一起修没)", () => {
    localStorage.setItem(ENABLED_KEY, "1");
    localStorage.setItem(TIMEOUT_KEY, "1");
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 30 * 60_000));
    const { result } = mountComposed();
    expect(result.current.locked).toBe(true);
  });
});

// 跨标签「锁」同步:任一标签锁 → 共享锁标志 + storage 广播 → 别的标签(含复制网址新开的)也锁。
// 解锁不同步:各标签自解。用 StorageEvent 模拟「另一个标签」的 localStorage 变更。
const LOCK_FLAG_KEY = "folio_lock_locked";
function fireStorage(key: string, newValue: string | null) {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}

describe("useIdleLock 跨标签锁同步", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("新标签 mount 时锁标志已置(别处已锁)→ 初始即锁", () => {
    localStorage.setItem(LOCK_FLAG_KEY, "1");
    const { result } = renderHook(() => useIdleLock(60_000));
    expect(result.current.locked).toBe(true);
  });

  it("收到别的标签的锁(storage 事件)→ 本标签也锁", () => {
    const { result } = renderHook(() => useIdleLock(60_000));
    expect(result.current.locked).toBe(false);
    act(() => fireStorage(LOCK_FLAG_KEY, String(Date.now())));
    expect(result.current.locked).toBe(true);
  });

  it("本标签到点锁 → 写入共享锁标志(别的标签可见)", () => {
    const { result } = renderHook(() => useIdleLock(60_000));
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.locked).toBe(true);
    expect(localStorage.getItem(LOCK_FLAG_KEY)).not.toBeNull();
  });

  it("别的标签解锁清标志(storage newValue=null)→ 本标签不跟随解锁", () => {
    localStorage.setItem(LOCK_FLAG_KEY, "1");
    const { result } = renderHook(() => useIdleLock(60_000));
    expect(result.current.locked).toBe(true);
    act(() => fireStorage(LOCK_FLAG_KEY, null)); // 别的标签解锁
    expect(result.current.locked).toBe(true); // 解锁不同步:本标签仍锁
  });

  it("unlock() → 清本地态 + 清共享锁标志", () => {
    localStorage.setItem(LOCK_FLAG_KEY, "1");
    const { result } = renderHook(() => useIdleLock(60_000));
    expect(result.current.locked).toBe(true);
    act(() => result.current.unlock());
    expect(result.current.locked).toBe(false);
    expect(localStorage.getItem(LOCK_FLAG_KEY)).toBeNull();
  });

  it("别的标签有活动(storage 刷新 lastActive)→ 本标签定时器顺延,不误锁", () => {
    const { result } = renderHook(() => useIdleLock(60_000));
    act(() => vi.advanceTimersByTime(30_000));
    // 别的标签在 30s 处活动 → 广播新的 lastActive → 本标签重排(从此刻起再算一整轮)。
    act(() => fireStorage(LAST_ACTIVE_KEY, String(Date.now())));
    act(() => vi.advanceTimersByTime(30_000)); // 原定时器到点(60s),但已顺延
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(30_000)); // 距顺延满 60s
    expect(result.current.locked).toBe(true);
  });
});
