import { useEffect, useState } from "react";

/**
 * 这台机器有没有**可做用户验证的平台认证器**(Touch ID / Face ID / Windows Hello / Android 指纹)。
 *
 * 与 usePasskeySupport 是两个不同的问题,别混:
 * - `usePasskeySupport` 答的是「这个**浏览器**认不认识 WebAuthn API」;
 * - 这个答的是「这台**机器**上有没有指纹/面容可用」。
 *
 * 为什么必须单独问一遍:闲置锁的注册限定了 `authenticatorAttachment: "platform"`,机器上没有这类
 * 认证器时,浏览器**不会报错** —— 它停在系统那层等一个够格的认证器(真机上就是「用其他设备」的二维码
 * 界面),ceremony 一直挂着不返回,于是我们的失败提示永远不出现。用户按了开关、关掉系统弹窗,什么都
 * 没发生也没有任何解释。E2E 里那条「认证器不支持用户验证」正好实测到了这个(#354)。
 *
 * 返回 `null` = 还没问出来(首帧 / 正在问)。三态是必要的:用 false 兜底会让开关在挂载瞬间先禁用
 * 再启用,闪一下。
 *
 * 注意这个 API 只回答「有没有」,**不回答「有没有你这个账户的凭据」**—— 后者在 Web 上探测不到
 * (有意的隐私设计),这也是为什么开启闲置锁还得当场跑一次 ceremony,见 lib/idle-lock.ts。
 */
export function usePlatformAuthenticator(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const pkc = typeof window === "undefined" ? undefined : window.PublicKeyCredential;
    if (!pkc || typeof pkc.isUserVerifyingPlatformAuthenticatorAvailable !== "function") {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    pkc
      .isUserVerifyingPlatformAuthenticatorAvailable()
      .then((ok) => {
        if (!cancelled) setAvailable(ok);
      })
      // 查不出来就按「没有」处理:宁可把开关禁掉并说清楚,也不要让人点了没反应。
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}
