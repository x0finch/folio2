import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_IDLE_TIMEOUT_RAW,
  IDLE_LOCK_ENABLED_KEY,
  IDLE_TIMEOUT_STORAGE_KEY,
  parseIdleTimeout,
} from "./idle-lock";

// 同标签内偏好变更广播：storage 事件只在「别的标签」改动时触发，本标签改动收不到，
// 故设置页改完自派发一个自定义事件，让同标签的锁屏即时拿到新值。
const IDLE_TIMEOUT_EVENT = "folio:idle-timeout-change";

function readRaw(): string {
  try {
    return localStorage.getItem(IDLE_TIMEOUT_STORAGE_KEY) ?? DEFAULT_IDLE_TIMEOUT_RAW;
  } catch {
    return DEFAULT_IDLE_TIMEOUT_RAW;
  }
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(IDLE_LOCK_ENABLED_KEY) != null;
  } catch {
    return false; // storage 不可用 → 当作没开(默认关,与「用户自行去设置里开」一致)
  }
}

// 闲置锁偏好(#292 起,每设备独立,localStorage)。**开关与时长是两件事**:
// enabled 管「要不要锁」,raw/timeoutMs 管「锁多久」——理由见 idle-lock.ts 的 IDLE_LOCK_ENABLED_KEY。
// 关掉不会动时长,所以再打开还是原来那个档。
//
// SSR 安全：首帧用默认(关 + 默认档)，挂载后读实际值 + 订阅变更。设置页 setRaw/setEnabled 写盘 +
// 广播 → 同标签的锁屏即时生效；storage 事件覆盖跨标签。
export function useIdleTimeout(): {
  raw: string;
  timeoutMs: number;
  enabled: boolean;
  setRaw: (next: string) => void;
  setEnabled: (next: boolean) => void;
} {
  const [raw, setRawState] = useState(DEFAULT_IDLE_TIMEOUT_RAW);
  const [enabled, setEnabledState] = useState(false);

  useEffect(() => {
    const sync = () => {
      setRawState(readRaw());
      setEnabledState(readEnabled());
    };
    sync(); // 挂载即读实际偏好
    // storage 事件对所有 key 触发，只在改的是这两个键(或整表被清，key===null)时才重读。
    const onStorage = (e: StorageEvent) => {
      if (e.key === IDLE_TIMEOUT_STORAGE_KEY || e.key === IDLE_LOCK_ENABLED_KEY || e.key === null) {
        sync();
      }
    };
    window.addEventListener(IDLE_TIMEOUT_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(IDLE_TIMEOUT_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setRaw = useCallback((next: string) => {
    try {
      localStorage.setItem(IDLE_TIMEOUT_STORAGE_KEY, next);
    } catch {
      // storage 不可用(隐私模式)：本次不持久化，仍在内存生效 —— 可接受
    }
    setRawState(next);
    window.dispatchEvent(new Event(IDLE_TIMEOUT_EVENT));
  }, []);

  // 关掉只移除开关键,**不动时长、也不动本机 passkey 记录** —— 再打开即恢复,无须重新验证。
  const setEnabled = useCallback((next: boolean) => {
    try {
      if (next) localStorage.setItem(IDLE_LOCK_ENABLED_KEY, "1");
      else localStorage.removeItem(IDLE_LOCK_ENABLED_KEY);
    } catch {}
    setEnabledState(next);
    window.dispatchEvent(new Event(IDLE_TIMEOUT_EVENT));
  }, []);

  return { raw, timeoutMs: parseIdleTimeout(raw), enabled, setRaw, setEnabled };
}
