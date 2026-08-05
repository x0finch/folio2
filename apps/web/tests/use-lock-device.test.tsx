import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useLockDevice } from "../src/lib/hooks/use-lock-device";

// 「这台设备上那条 passkey 的 id」(#353)。它是闲置锁的第二道门:没有它 → LockScreen 不挂锁。
// 存 id 而不是布尔,是为了让设置页能标出「哪条是这台设备的」、并在删除时精确判断 —— 判据与理由见
// lib/idle-lock.ts 的 LOCK_DEVICE_PASSKEY_KEY。
const KEY = "folio_lock_device_passkey";

describe("useLockDevice", () => {
  beforeEach(() => localStorage.clear());

  it("没有记录 → 未就绪,拿不到 id", () => {
    const { result } = renderHook(() => useLockDevice());
    expect(result.current.ready).toBe(false);
    expect(result.current.credentialId).toBeNull();
  });

  it("已有记录 → 挂载后就绪,并把 id 交出来(列表靠它比对)", () => {
    localStorage.setItem(KEY, "pk_abc");
    const { result } = renderHook(() => useLockDevice());
    expect(result.current.ready).toBe(true);
    expect(result.current.credentialId).toBe("pk_abc");
  });

  it("markReady(id) → 存的是那个 id,不是布尔", () => {
    const { result } = renderHook(() => useLockDevice());
    act(() => result.current.markReady("pk_new"));
    expect(result.current.credentialId).toBe("pk_new");
    expect(localStorage.getItem(KEY)).toBe("pk_new");
  });

  // 本机那条 passkey 被删时走这条(settings 的 PasskeysCard 精确比对 id 后调用)。
  it("clearReady → 回到未就绪并清盘", () => {
    localStorage.setItem(KEY, "pk_abc");
    const { result } = renderHook(() => useLockDevice());
    act(() => result.current.clearReady());
    expect(result.current.ready).toBe(false);
    expect(result.current.credentialId).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  // 别的标签改了记录 → 本标签跟随。storage 事件只在「别的标签」改动时触发,故手工派发模拟。
  it("跟随别的标签的改动(storage 事件)", () => {
    const { result } = renderHook(() => useLockDevice());
    expect(result.current.ready).toBe(false);
    act(() => {
      localStorage.setItem(KEY, "pk_other");
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "pk_other" }));
    });
    expect(result.current.credentialId).toBe("pk_other");
  });

  // 整表被清(key === null)也要重读 —— 否则「清空 storage」后本标签仍以为就绪。
  it("整表被清 → 重读为未就绪", () => {
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
