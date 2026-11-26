import { Button, cn, Input, Label, MorphingModal, Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { Fingerprint } from "@folio/ui/icons";
import { WebAuthnAbortService } from "@simplewebauthn/browser";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { authClient, signIn, signUp } from "@/lib/core/auth-client";
import type { HistoryPoint } from "@/lib/core/history";
import { useLockDevice } from "@/lib/hooks/use-lock-device";
import type { HoldingLike } from "@/routes/_authed/-home/hero/hero-stats";
import { PortfolioHero } from "@/routes/_authed/-home/hero/portfolio-hero";
import { registerPasskey } from "@/routes/_authed/-settings/passkey/register-passkey";
import { AuthShell } from "./auth-shell";
import { deriveDefaultName } from "./derive-default-name";
import {
  dismissPasskeyPrompt,
  isPasskeyPromptDismissed,
  shouldPromptForPasskey,
} from "./passkey-prompt";

const DAY_MS = 86_400_000;

// Fake data for the decorative backdrop. Noise from sin, not Math.random, so SSR and client match.
const DEMO_SERIES: HistoryPoint[] = Array.from({ length: 28 }, (_, i) => ({
  t: i * DAY_MS,
  total: 150_000 + i * 3_600 + Math.max(0, i - 19) ** 2 * 900 + Math.sin(i * 0.9) * 3_500,
}));
const DEMO_START_TOTAL = 312_450.42;
const DEMO_GAIN = { amount: 4_820.15, pct: 1.57, segments: [] };
const DEMO_HOLDINGS: HoldingLike[] = [
  { token: { symbol: "BTC" }, totalValue: 112_400, gain24h: { amount: 2_310, pct: 2.1 } },
  { token: { symbol: "ETH" }, totalValue: 61_250, gain24h: { amount: 2_012, pct: 3.4 } },
  { token: { symbol: "SOL" }, totalValue: 20_000, gain24h: { amount: -243, pct: -1.2 } },
  { token: { symbol: "USDC" }, totalValue: 40_000, gain24h: { amount: 0, pct: 0 } },
];

export function LoginPage() {
  return (
    <AuthShell background={<HeroBackdrop />}>
      <AuthPanel />
      <ReadOnlyLine />
    </AuthShell>
  );
}

function HeroBackdrop() {
  const [total, setTotal] = useState(DEMO_START_TOTAL);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setTotal((v) => v + Math.round(50 + Math.random() * 250)); // +$50–$300
      timer = setTimeout(tick, 8_000 + Math.random() * 7_000); // every 8–15s
    };
    timer = setTimeout(tick, 6_000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center overflow-hidden"
    >
      {/* 63vw × scale 1.6 ≈ 100.8vw rendered (origin-left), so the chart spans the window. */}
      <div className="w-[63vw] origin-left scale-[1.6] blur-sm">
        <PortfolioHero
          series={DEMO_SERIES}
          totalUsd={total}
          gain24h={DEMO_GAIN}
          holdings={DEMO_HOLDINGS}
          contentClassName="px-8"
        />
      </div>
    </div>
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
      <p className="font-medium text-lg">{isSignup ? t("signUpTitle") : t("signInTitle")}</p>
      <p className="mt-1 mb-5 text-muted-foreground text-sm">{t("tagline")}</p>

      <Tabs
        value={mode}
        onValueChange={(v) => {
          setMode(v as "signin" | "signup");
          setError(null);
        }}
        variant="pill"
      >
        <TabsList className="mb-5 bg-muted dark:bg-background">
          <TabsTrigger value="signin">{t("signIn")}</TabsTrigger>
          <TabsTrigger value="signup">{t("signUp")}</TabsTrigger>
        </TabsList>
      </Tabs>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
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
            "-mb-4 grid transition-[grid-template-rows,margin] duration-200 ease-out",
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
          <p className="font-semibold text-base">{t("passkeyPromptTitle")}</p>
          <p className="mt-1.5 text-muted-foreground text-sm">{t("passkeyPromptBody")}</p>
          <div className="mt-5 flex justify-end gap-2">
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

function ReadOnlyLine() {
  const t = useTranslations("Login");
  return (
    <p className="absolute inset-x-0 bottom-[calc(1.25rem_+_env(safe-area-inset-bottom))] z-10 px-6 text-center text-muted-foreground text-xs">
      {t("readOnlyHint")}
    </p>
  );
}
