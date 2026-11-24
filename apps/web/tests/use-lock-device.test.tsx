import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useLockDevice } from "@/lib/hooks/use-lock-device";

const KEY = "folio_lock_device_passkey";

describe("useLockDevice", () => {
  beforeEach(() => localStorage.clear());

  it("no record: not ready, no id", () => {
    const { result } = renderHook(() => useLockDevice());
    expect(result.current.ready).toBe(false);
    expect(result.current.credentialId).toBeNull();
  });

  it("existing record: ready after mount, and hands out the id (the list compares against it)", () => {
    localStorage.setItem(KEY, "pk_abc");
    const { result } = renderHook(() => useLockDevice());
    expect(result.current.ready).toBe(true);
    expect(result.current.credentialId).toBe("pk_abc");
  });

  it("markReady(id): stores that id, not a boolean", () => {
    const { result } = renderHook(() => useLockDevice());
    act(() => result.current.markReady("pk_new"));
    expect(result.current.credentialId).toBe("pk_new");
    expect(localStorage.getItem(KEY)).toBe("pk_new");
  });

  it("clearReady: back to not ready and wipes storage", () => {
    localStorage.setItem(KEY, "pk_abc");
    const { result } = renderHook(() => useLockDevice());
    act(() => result.current.clearReady());
    expect(result.current.ready).toBe(false);
    expect(result.current.credentialId).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("follows changes from other tabs (storage event)", () => {
    const { result } = renderHook(() => useLockDevice());
    expect(result.current.ready).toBe(false);
    act(() => {
      localStorage.setItem(KEY, "pk_other");
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "pk_other" }));
    });
    expect(result.current.credentialId).toBe("pk_other");
  });

  it("whole table cleared: re-read as not ready", () => {
    localStorage.setItem(KEY, "pk_abc");
    const { result } = renderHook(() => useLockDevice());
    expect(result.current.ready).toBe(true);
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current.ready).toBe(false);
  });
});
