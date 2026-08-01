import { useEffect, useState } from "react";

// 浏览器是否支持 WebAuthn(passkey)。SSR / hydration 安全：render 期恒 false，挂载后才可能置真
// —— 首帧与服务端一致，避免闪。抽成 hook 供 settings / 锁屏共用(行为用 hook 复用，非包组件)。
export function usePasskeySupport(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(typeof window !== "undefined" && !!window.PublicKeyCredential);
  }, []);
  return supported;
}
