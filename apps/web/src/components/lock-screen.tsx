import { Button, Input } from "@folio/ui";
import { Fingerprint } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { signIn } from "../lib/auth-client";
import { useIdleLock } from "../lib/hooks/use-idle-lock";
import { useIdleTimeout } from "../lib/hooks/use-idle-timeout";
import { usePasskeySupport } from "../lib/hooks/use-passkey-support";
import { AuthShell } from "./auth-shell";

// 应用层闲置锁屏(ADR 0029 / #291）。父组件包裹 —— 锁定时**卸载 children**(不只是遮罩盖住):
// DOM 里不留内容,懂开发的人删掉遮罩也看不到底下数据。代价 = 组件本地态(滚动 / 展开 / 半填表单)丢失;
// 数据本身由更外层 QueryClient 缓存,重挂从缓存出、不重拉。防不住直接打 server fn / 读本机 D1(那层要
// 服务端锁),此层只封前端 DOM。逻辑在 useIdleLock hook;这里只管样子 + 解锁(复用 signIn,会话不销毁)。
export function LockScreen({ userEmail, children }: { userEmail: string; children: ReactNode }) {
  const { timeoutMs } = useIdleTimeout();
  // 永不(timeoutMs===null,含默认)→ 不挂闲置锁:整套活动监听 / 定时器 / 挂载比对都不进树。
  // 「永不」从「运行时到处判 null」升级为「根本不运行」,结构上消除整类漏判 null 的误锁(ADR 0029)。
  if (timeoutMs === null) return <>{children}</>;
  return (
    <ActiveLockScreen userEmail={userEmail} timeoutMs={timeoutMs}>
      {children}
    </ActiveLockScreen>
  );
}

// 有具体超时档时才挂:useIdleLock 在此子组件内无条件调用(符合 hooks 规则)。切到「永不」即
// 卸载本组件、清掉监听与定时器 —— 无需在 hook 里对 null 层层设防。
function ActiveLockScreen({
  userEmail,
  timeoutMs,
  children,
}: {
  userEmail: string;
  timeoutMs: number;
  children: ReactNode;
}) {
  const { locked, unlock } = useIdleLock(timeoutMs);
  // 锁定 → 用锁屏**替换** children(卸载,不叠加):DOM 里不留内容,删遮罩也看不到底下数据。
  // 解锁重挂,数据从更外层 QueryClient 缓存出,不重拉;丢的只是组件本地态(滚动/展开/半填表单)。
  return locked ? <LockOverlay userEmail={userEmail} onUnlock={unlock} /> : children;
}

function LockOverlay({ userEmail, onUnlock }: { userEmail: string; onUnlock: () => void }) {
  const t = useTranslations("Lock");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const supportsPasskey = usePasskeySupport();

  // 锁定期间锁住底层滚动:fixed 遮罩只是视觉盖住,滚轮/触摸会穿透(scroll chaining)到底下的
  // App。锁 html(文档滚动容器)+ body 双保险;LockOverlay 仅锁定时渲染,挂载即锁、卸载即还原。
  useEffect(() => {
    const root = document.documentElement;
    const prevRoot = root.style.overflow;
    const prevBody = document.body.style.overflow;
    root.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      root.style.overflow = prevRoot;
      document.body.style.overflow = prevBody;
    };
  }, []);

  async function onPasskey() {
    setError(false);
    setBusy(true);
    try {
      // signIn.passkey() 可能返回 undefined(用户取消 ceremony)，故可选链；signIn.email 不会。
      const res = await signIn.passkey();
      if (res?.error) setError(true);
      else onUnlock();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function onPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(false);
    setBusy(true);
    try {
      const res = await signIn.email({ email: userEmail, password });
      if (res.error) setError(true);
      else onUnlock();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    // 接管态：盖住一切，无关闭按钮、点外部不关。复用 AuthShell(左上品牌 / 右上语言主题),
    // 背景=磨砂 blur 糊住底下 App;fixed 覆盖层定位由 className 传入。
    <AuthShell
      className="fixed inset-0 z-50"
      background={<div className="absolute inset-0 bg-background/50 backdrop-blur-md" />}
    >
      <div className="flex w-full max-w-sm flex-col gap-4">
        <p className="font-medium text-lg">{t("title")}</p>
        <p className="-mt-2 text-muted-foreground text-sm">{t("subtitle")}</p>

        {supportsPasskey ? (
          <Button type="button" className="w-full" disabled={busy} onClick={onPasskey}>
            <Fingerprint className="size-4" />
            {t("unlockWithPasskey")}
          </Button>
        ) : null}

        {supportsPasskey ? (
          <div className="flex w-full items-center gap-3 text-muted-foreground text-xs">
            <span className="h-px flex-1 bg-border" />
            {t("or")}
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : null}

        <form onSubmit={onPassword} className="flex w-full flex-col gap-3">
          {/* 隐藏只读 email(username)让密码管理器把这条密码关联到本账户、一键代填(#289)。 */}
          <input
            type="email"
            value={userEmail}
            readOnly
            autoComplete="username"
            tabIndex={-1}
            aria-hidden
            className="sr-only"
          />
          <Input
            type="password"
            required
            autoComplete="current-password"
            placeholder={t("password")}
            value={password}
            onChange={setPassword}
            disabled={busy}
          />
          {error ? <p className="text-destructive text-sm">{t("failed")}</p> : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "…" : t("unlock")}
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}
