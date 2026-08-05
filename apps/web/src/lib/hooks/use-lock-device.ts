import { useCallback, useEffect, useState } from "react";
import { LOCK_DEVICE_PASSKEY_KEY } from "../idle-lock";

// 同标签内广播:storage 事件只在「别的标签」改动时触发,本标签改动收不到 —— 设置页标记就绪后
// 自派发一个事件,让同标签的 LockScreen 即时拿到新值。与 use-idle-timeout 同款。
const LOCK_DEVICE_EVENT = "folio:lock-device-change";

function read(): string | null {
  try {
    return localStorage.getItem(LOCK_DEVICE_PASSKEY_KEY);
  } catch {
    return null; // 隐私模式 / storage 不可用 → 读不到就当没有,只影响显示,不影响锁不锁
  }
}

// 「这台设备能用 passkey 解锁」+ 是**哪一条**凭据(#353,判据与理由见 idle-lock.ts 的
// LOCK_DEVICE_PASSKEY_KEY)。存 WebAuthn credentialID 不存布尔,好处见那里。
// SSR 安全:render 期恒 null,挂载后才可能有值 —— 首帧与服务端一致,避免闪。
//
// **这个标记不决定锁不锁。** 它只回答「这台设备登记的是哪一条凭据」,用途是:列表上标「这台设备」、
// 锁屏上提示一句、设置页告诉用户需不需要重新登记。锁不锁只看开关键(见 lock-screen.tsx:没登记也照锁,
// 出路是登出重登)。所以读不到、过期、指错行,都只是显示不准,不会把人关在门外也不会漏锁。
export function useLockDevice(): {
  credentialId: string | null;
  ready: boolean;
  markReady: (credentialId: string) => void;
  clearReady: () => void;
} {
  const [credentialId, setCredentialId] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setCredentialId(read());
    sync(); // 挂载即读实际值
    // storage 事件对所有 key 触发,只在改的是本键(或整表被清,key===null)时才重读。
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOCK_DEVICE_PASSKEY_KEY || e.key === null) sync();
    };
    window.addEventListener(LOCK_DEVICE_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(LOCK_DEVICE_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // 只在本机凭据被证明可用后调用:platform 注册成功,或注册被拒后验证一次成功(见 AutoLockCard)。
  const markReady = useCallback((id: string) => {
    try {
      localStorage.setItem(LOCK_DEVICE_PASSKEY_KEY, id);
    } catch {
      // storage 不可用:本次不持久化,仍在内存生效 —— 下次打开要重新启用,可接受
    }
    setCredentialId(id);
    window.dispatchEvent(new Event(LOCK_DEVICE_EVENT));
  }, []);

  // 本机那条凭据没了时调用(在这台设备上删掉,或在别处删了、本页发现 id 已不在列表里)。
  const clearReady = useCallback(() => {
    try {
      localStorage.removeItem(LOCK_DEVICE_PASSKEY_KEY);
    } catch {}
    setCredentialId(null);
    window.dispatchEvent(new Event(LOCK_DEVICE_EVENT));
  }, []);

  return { credentialId, ready: credentialId != null, markReady, clearReady };
}
