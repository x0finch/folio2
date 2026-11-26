import { Button, cn, Input, Label, MorphingModal, Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { Fingerprint } from "@folio/ui/icons";
import { WebAuthnAbortService } from "@simplewebauthn/browser";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { authClient, signIn, signUp } from "@/lib/core/auth-client";
import { useLockDevice } from "@/lib/hooks/use-lock-device";
import { registerPasskey } from "@/routes/_authed/-settings/passkey/register-passkey";
import { AuthShell } from "./auth-shell";
import { deriveDefaultName } from "./derive-default-name";
import {
  dismissPasskeyPrompt,
  isPasskeyPromptDismissed,
  shouldPromptForPasskey,
} from "./passkey-prompt";

export function LoginPage() {
  return (
    <AuthShell background={<Backdrop />}>
      <AuthPanel />
    </AuthShell>
  );
}

// A pre-rendered, already blurred picture of the dashboard: decoration only, so nothing is computed
// or animated for it. One file per theme because the page background is baked in.
function Backdrop() {
  // Phones show only the right-hand part, lower on the screen: the faint trend line, without the
  // blurred figures that would sit right behind the form.
  const image =
    "pointer-events-none absolute inset-x-0 bottom-0 h-3/5 w-full object-cover object-right sm:inset-0 sm:size-full sm:object-left";
  return (
    <>
      <img src="/login-backdrop-light.jpg" alt="" className={cn(image, "dark:hidden")} />
      <img src="/login-backdrop-dark.jpg" alt="" className={cn(image, "hidden dark:block")} />
    </>
  );
}

// The pending conditional-UI request lives on WebKit's WebPageProxy, not the document: navigation
// doesn't cancel it, and iOS 26 re-shows the password autofill sheet on every reactivation. Only a
// JS AbortSignal kills it, so always abort before leaving the login page.
function abortAutofill() {
  WebAuthnAbortService.cancelCeremony();
}

function AuthPanel() {
  const navigate = useNavigate();
  const t = useTranslations("Login");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [supportsPasskey, setSupportsPasskey] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  // Passkeys added from the prompt must be recorded as this device's, or auto-lock re-registers.
  const { markReady } = useLockDevice();

  // Abort first (see abortAutofill), then SPA-navigate: a hard navigation would unmount the form
  // mid-interaction when triggered from the autofill callback.
  const leaveToHome = useCallback(() => {
    abortAutofill();
    navigate({ to: "/" });
  }, [navigate]);

  const isSignup = mode === "signup";

  async function afterEmailAuth() {
    if (supportsPasskey && !isPasskeyPromptDismissed()) {
      const res = await authClient.passkey.listUserPasskeys().catch(() => null);
      const passkeyCount = res?.data?.length ?? 0;
      if (shouldPromptForPasskey({ supported: true, dismissed: false, passkeyCount })) {
        setPromptOpen(true);
        return;
      }
    }
    leaveToHome();
  }

  // A failure still goes home: the prompt is optional and must not block sign-in. Records the
  // credential id so settings can tell which passkey is this device's, but doesn't enable idle lock:
  // the user agreed to a passkey, not to auto-locking.
  async function onAddFromPrompt() {
    setPromptOpen(false);
    const res = await registerPasskey("platform").catch(() => null);
    if (res?.data) markReady(res.data.credentialID);
    leaveToHome();
  }

  function onDismissPrompt() {
    dismissPasskeyPrompt();
    setPromptOpen(false);
    leaveToHome();
  }

  useEffect(() => {
    if (typeof window === "undefined" || !window.PublicKeyCredential) return;
    setSupportsPasskey(true);
    const pkc = window.PublicKeyCredential;
    if (typeof pkc.isConditionalMediationAvailable !== "function") return;
    let cancelled = false;
    pkc
      .isConditionalMediationAvailable()
      .then((ok) => {
        if (!ok || cancelled) return;
        return signIn.passkey({ autoFill: true }).then((res) => {
          if (!cancelled && res && !res.error) leaveToHome();
        });
      })
      .catch(() => {}); // failures/cancellations are routine
    // Also abort on pagehide: React skips effect cleanup on full-page navigation.
    window.addEventListener("pagehide", abortAutofill);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", abortAutofill);
      abortAutofill();
    };
  }, [leaveToHome]);

  async function onPasskey() {
    setError(null);
    setBusy(true);
    try {
      const res = await signIn.passkey();
      if (res?.error) {
        setError(res.error.message ?? t("authFailed"));
        return;
      }
      leaveToHome();
    } catch {
      setError(t("authFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function submitEmailAuth() {
    setError(null);
    setBusy(true);
    try {
      const res = isSignup
        ? await signUp.email({ email, password, name: name.trim() || deriveDefaultName(email) })
        : await signIn.email({ email, password });
      if (res.error) {
        setError(res.error.message ?? t("authFailed"));
        return;
      }
      await afterEmailAuth();
    } catch {
      // A rejection must land in the error state or `busy` sticks.
      setError(t("authFailed"));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void submitEmailAuth();
  }

  // Auto-submit only on the autofill signal, never on typing, and only once (no retry loop on a
  // wrong password).
  const autoSubmittedRef = useRef(false);
  const [autofilled, setAutofilled] = useState({ email: false, password: false });
  function onFieldAutofill(field: "email" | "password") {
    return (e: React.AnimationEvent) => {
      // Only our probe animation (styles.css input:-webkit-autofill).
      if (e.animationName === "folio-autofill") {
        setAutofilled((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
      }
    };
  }
  // submitEmailAuth is deliberately not a dep: re-runs already see the latest closure, and the ref
  // guarantees a single submit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (isSignup || busy || autoSubmittedRef.current) return;
    if (!autofilled.email || !autofilled.password) return;
    // Wait for controlled state to catch up: onChange and animationstart can arrive out of order.
    if (!email || password.length < 8) return;
    autoSubmittedRef.current = true;
    void submitEmailAuth();
  }, [autofilled, email, password, isSignup, busy]);

  return (
    <div className="w-full max-w-sm">
      <h1 className="mb-8 font-semibold text-lg">
        {isSignup ? t("signUpTitle") : t("signInTitle")}
      </h1>

      <Tabs
        value={mode}
        onValueChange={(v) => {
          setMode(v as "signin" | "signup");
          setError(null);
        }}
        variant="pill"
      >
        <TabsList className="mb-8 bg-muted dark:bg-background">
          <TabsTrigger value="signin">{t("signIn")}</TabsTrigger>
          <TabsTrigger value="signup">{t("signUp")}</TabsTrigger>
        </TabsList>
      </Tabs>

      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">{t("email")}</Label>
          {/* `webauthn` must be the last autocomplete token to enable conditional-UI autofill. */}
          <Input
            id="email"
            type="email"
            required
            autoComplete="username webauthn"
            value={email}
            onChange={(v) => setEmail(v)}
            onAnimationStart={onFieldAutofill("email")}
          />
        </div>

        <div
          className={cn(
            "-mb-6 grid transition-[grid-template-rows,margin] duration-200 ease-out",
            isSignup ? "mb-0 grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">{t("name")}</Label>
              <Input
                id="name"
                autoComplete="name"
                value={name}
                placeholder={deriveDefaultName(email)}
                onChange={(v) => setName(v)}
                tabIndex={isSignup ? undefined : -1}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="password">{t("password")}</Label>
          <Input
            id="password"
            type="password"
            required
            minLength={8}
            autoComplete={isSignup ? "new-password" : "current-password"}
            value={password}
            onChange={(v) => setPassword(v)}
            onAnimationStart={onFieldAutofill("password")}
          />
        </div>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? "…" : isSignup ? t("signUp") : t("signIn")}
        </Button>
        {!isSignup && supportsPasskey && (
          <Button type="button" variant="outline" disabled={busy} onClick={onPasskey}>
            <Fingerprint />
            {t("signInWithPasskey")}
          </Button>
        )}
      </form>

      {/* Dismissing by clicking outside skips only this time (not persisted). */}
      <MorphingModal
        viewId={promptOpen ? "passkey-prompt" : null}
        onClose={() => {
          setPromptOpen(false);
          leaveToHome();
        }}
      >
        <div className="text-left">
          <p className="font-semibold text-lg">{t("passkeyPromptTitle")}</p>
          <p className="mt-2 text-muted-foreground text-sm">{t("passkeyPromptBody")}</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={onDismissPrompt}>
              {t("passkeyPromptDismiss")}
            </Button>
            <Button onClick={onAddFromPrompt}>
              <Fingerprint />
              {t("passkeyPromptAdd")}
            </Button>
          </div>
        </div>
      </MorphingModal>
    </div>
  );
}
