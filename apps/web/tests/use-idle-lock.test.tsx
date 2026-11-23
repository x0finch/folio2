import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIdleLock } from "@/lib/hooks/use-idle-lock";
import { useIdleTimeout } from "@/lib/hooks/use-idle-timeout";

describe("useIdleLock timer resets when timeoutMs changes tier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("concrete tier elapses: locks (baseline)", () => {
    const { result } = renderHook(() => useIdleLock(60_000));
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.locked).toBe(true);
  });

  it('after switching from a concrete tier to "never": the old timer no longer locks', () => {
    const { result, rerender } = renderHook(({ t }: { t: number | null }) => useIdleLock(t), {
      initialProps: { t: (5 * 60_000) as number | null },
    });
    expect(result.current.locked).toBe(false);

    rerender({ t: null });
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(result.current.locked).toBe(false);
  });

  it('switching from "never" to a concrete tier: locks when the new tier elapses', () => {
    const { result, rerender } = renderHook(({ t }: { t: number | null }) => useIdleLock(t), {
      initialProps: { t: null as number | null },
    });
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(result.current.locked).toBe(false);

    rerender({ t: 60_000 });
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.locked).toBe(true);
  });
});

const LAST_ACTIVE_KEY = "folio_lock_last_active";
const TIMEOUT_KEY = "folio_lock_timeout";
const ENABLED_KEY = "folio_lock_enabled";

describe("useIdleTimeout + useIdleLock combined: switch off never locks by mistake", () => {
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

  it("switch off + stale lastActive (30 minutes ago): never locks", () => {
    localStorage.setItem(TIMEOUT_KEY, "1");
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 30 * 60_000));
    const { result } = mountComposed();
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(result.current.locked).toBe(false);
  });

  it("default (nothing set) + stale lastActive: no lock (default off)", () => {
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 30 * 60_000));
    const { result } = mountComposed();
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(result.current.locked).toBe(false);
  });

  it("leftover old never value + switch unset: still no lock (compat)", () => {
    localStorage.setItem(TIMEOUT_KEY, "never");
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 30 * 60_000));
    const { result } = mountComposed();
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(result.current.locked).toBe(false);
  });

  it("switch on + 1 minute + stale lastActive: locks as usual (the real lock was not fixed away)", () => {
    localStorage.setItem(ENABLED_KEY, "1");
    localStorage.setItem(TIMEOUT_KEY, "1");
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 30 * 60_000));
    const { result } = mountComposed();
    expect(result.current.locked).toBe(true);
  });
});

const LOCK_FLAG_KEY = "folio_lock_locked";
function fireStorage(key: string, newValue: string | null) {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}

describe("useIdleLock cross-tab lock sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("new tab mounts with the lock flag already set (locked elsewhere): locked initially", () => {
    localStorage.setItem(LOCK_FLAG_KEY, "1");
    const { result } = renderHook(() => useIdleLock(60_000));
    expect(result.current.locked).toBe(true);
  });

  it("receives a lock from another tab (storage event): this tab locks too", () => {
    const { result } = renderHook(() => useIdleLock(60_000));
    expect(result.current.locked).toBe(false);
    act(() => fireStorage(LOCK_FLAG_KEY, String(Date.now())));
    expect(result.current.locked).toBe(true);
  });

  it("this tab locks on timeout: writes the shared lock flag (visible to other tabs)", () => {
    const { result } = renderHook(() => useIdleLock(60_000));
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.locked).toBe(true);
    expect(localStorage.getItem(LOCK_FLAG_KEY)).not.toBeNull();
  });

  it("another tab unlocks and clears the flag (storage newValue=null): this tab does not follow the unlock", () => {
    localStorage.setItem(LOCK_FLAG_KEY, "1");
    const { result } = renderHook(() => useIdleLock(60_000));
    expect(result.current.locked).toBe(true);
    act(() => fireStorage(LOCK_FLAG_KEY, null));
    expect(result.current.locked).toBe(true);
  });

  it("unlock(): clears local state and the shared lock flag", () => {
    localStorage.setItem(LOCK_FLAG_KEY, "1");
    const { result } = renderHook(() => useIdleLock(60_000));
    expect(result.current.locked).toBe(true);
    act(() => result.current.unlock());
    expect(result.current.locked).toBe(false);
    expect(localStorage.getItem(LOCK_FLAG_KEY)).toBeNull();
  });

  it("activity in another tab (storage refreshes lastActive): this tab's timer is postponed, no false lock", () => {
    const { result } = renderHook(() => useIdleLock(60_000));
    act(() => vi.advanceTimersByTime(30_000));
    act(() => fireStorage(LAST_ACTIVE_KEY, String(Date.now())));
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.locked).toBe(true);
  });
});
