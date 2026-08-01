import { Button, Input } from "@folio/ui";
import { Fingerprint } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import { signIn } from "../lib/auth-client";
import { useIdleLock } from "../lib/hooks/use-idle-lock";
import { usePasskeySupport } from "../lib/hooks/use-passkey-support";
import { DEFAULT_IDLE_TIMEOUT_MS } from "../lib/idle-lock";
import { Logo } from "./logo";

// 应用层闲置锁屏(ADR 0029 / #291）。父组件包裹 —— 锁定时遮罩「叠加」在 children 之上，
// 绝不替换 children(替换会卸载整个 App，解锁后滚动位置 / 展开态 / 半填表单全丢)。
// 逻辑在 useIdleLock hook；这里只管样子 + 解锁(复用 signIn，会话不销毁，零新 server 接口)。
export function LockScreen({ userEmail, children }: { userEmail: string; children: ReactNode }) {
  const { locked, unlock } = useIdleLock(DEFAULT_IDLE_TIMEOUT_MS);
  return (
    <>
      {children}
      {locked ? <LockOverlay userEmail={userEmail} onUnlock={unlock} /> : null}
    </>
  );
}

function LockOverlay({ userEmail, onUnlock }: { userEmail: string; onUnlock: () => void }) {
  const t = useTranslations("Lock");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const supportsPasskey = usePasskeySupport();

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
    // 接管态：盖住一切，无关闭按钮、点外部不关。背景磨砂 blur(不加卡片，参考登录页)。
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-6 backdrop-blur-xl">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <Logo className="size-7 shrink-0" />
          <p className="font-medium text-lg">{t("title")}</p>
        </div>
        <p className="-mt-3 text-muted-foreground text-sm">{t("subtitle")}</p>

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
    </div>
  );
}
