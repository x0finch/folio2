import { Button } from "@folio/ui";
import { Fingerprint, LogOut } from "@folio/ui/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { signIn, signOut } from "@/lib/core/auth-client";
import { clearIdleLockState, useIdleLock } from "@/lib/hooks/use-idle-lock";
import { useIdleTimeout } from "@/lib/hooks/use-idle-timeout";
import { useLockDevice } from "@/lib/hooks/use-lock-device";
import { forgetQueryCache, lockQueryCache, queryPersistence } from "@/lib/queries/persist";
import { AuthShell } from "@/routes/-login/auth-shell";

// Locking unmounts children rather than overlaying them, so removing the overlay in devtools
// reveals nothing; the query cache is cleared too. This only protects the DOM, not server fns.
// Unlock accepts only a passkey: a password manager would prefill a password, which proves
// identity, not presence.
export function LockScreen({ children }: { children: ReactNode }) {
  const { timeoutMs, enabled } = useIdleTimeout();
  // When disabled, no listeners or timers are mounted at all. There is deliberately no bypass
  // for a missing device passkey record: clearing site data is exactly when the lock matters,
  // and sign-out is always available on the lock screen.
  if (!enabled) return <>{children}</>;
  return <ActiveLockScreen timeoutMs={timeoutMs}>{children}</ActiveLockScreen>;
}

// Separate component so useIdleLock is called unconditionally.
function ActiveLockScreen({ timeoutMs, children }: { timeoutMs: number; children: ReactNode }) {
  const { locked, unlock } = useIdleLock(timeoutMs);
  const queryClient = useQueryClient();
  // The persisted cache is the whole portfolio; leaving it on disk while locked defeats the lock.
  useEffect(() => {
    if (!locked) return;
    void lockQueryCache(queryClient);
    return () => queryPersistence().resume(queryClient);
  }, [locked, queryClient]);
  return locked ? <LockOverlay onUnlock={unlock} /> : children;
}

function LockOverlay({ onUnlock }: { onUnlock: () => void }) {
  const t = useTranslations("Lock");
  const tc = useTranslations("Common");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // The button stays even without a record: clearing site data keeps the platform passkey.
  const { ready } = useLockDevice();

  // A fixed overlay doesn't stop scroll chaining to the app underneath.
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
      // Resolves to undefined when the user cancels the ceremony.
      const res = await signIn.passkey();
      if (res?.error) setError(true);
      else onUnlock();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  // Escape hatch with no confirmation: it's the fallback for "I can't get in". Clearing the
  // lock state avoids re-locking on the next sign-in; clearing the cache hides the old portfolio.
  async function onSignOut() {
    setBusy(true);
    clearIdleLockState();
    try {
      await signOut();
    } finally {
      // After signOut: clearing broadcasts to other tabs, which re-auth; with a live session
      // they would resume writing the cache.
      await forgetQueryCache(queryClient);
      navigate({ to: "/login" });
    }
  }

  return (
    // Takeover: no close button, no outside click; sign-out is the only other way out.
    <AuthShell
      className="fixed inset-0 z-50"
      background={<div className="absolute inset-0 bg-background/50 backdrop-blur-md" />}
    >
      <div className="flex w-full max-w-sm flex-col gap-4">
        <p className="font-semibold text-lg">{t("title")}</p>
        {!ready && <p className="-mt-2 text-muted-foreground text-sm">{t("noDeviceCredential")}</p>}

        <Button type="button" className="w-full" disabled={busy} onClick={onPasskey}>
          <Fingerprint />
          {busy ? "…" : t("unlockWithPasskey")}
        </Button>
        {error ? <p className="text-destructive text-sm">{t("failed")}</p> : null}

        <Button
          type="button"
          variant="ghost"
          className="w-full"
          disabled={busy}
          onClick={onSignOut}
        >
          <LogOut />
          {tc("signOut")}
        </Button>
      </div>
    </AuthShell>
  );
}
