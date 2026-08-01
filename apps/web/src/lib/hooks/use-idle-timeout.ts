import { useCallback, useEffect, useState } from "react";
import { DEFAULT_IDLE_TIMEOUT_RAW, IDLE_TIMEOUT_STORAGE_KEY, parseIdleTimeout } from "../idle-lock";

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

function writeRaw(v: string): void {
  try {
    localStorage.setItem(IDLE_TIMEOUT_STORAGE_KEY, v);
  } catch {
    // storage 不可用(隐私模式)：本次不持久化，仍在内存生效 —— 可接受
  }
}

// 闲置超时偏好(#292，每设备独立，localStorage)。SSR 安全：首帧用默认，挂载后读实际值 +
// 订阅变更。设置页 setRaw 写盘 + 广播 → 同标签的锁屏即时生效；storage 事件覆盖跨标签。
export function useIdleTimeout(): {
  raw: string;
  timeoutMs: number | null;
  setRaw: (next: string) => void;
} {
  const [raw, setRawState] = useState(DEFAULT_IDLE_TIMEOUT_RAW);

  useEffect(() => {
    const sync = () => setRawState(readRaw());
    sync(); // 挂载即读实际偏好
    window.addEventListener(IDLE_TIMEOUT_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(IDLE_TIMEOUT_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setRaw = useCallback((next: string) => {
    writeRaw(next);
    setRawState(next);
    window.dispatchEvent(new Event(IDLE_TIMEOUT_EVENT));
  }, []);

  return { raw, timeoutMs: parseIdleTimeout(raw), setRaw };
}
