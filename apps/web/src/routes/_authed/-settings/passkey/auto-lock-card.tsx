import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
} from "@folio/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { authClient, signIn } from "@/lib/core/auth-client";
import { IDLE_TIMEOUT_MINUTES } from "@/lib/hooks/idle-lock";
import { useIdleTimeout } from "@/lib/hooks/use-idle-timeout";
import { useLockDevice } from "@/lib/hooks/use-lock-device";
import { SettingRow } from "@/routes/_authed/-settings/setting-row";
import { errorCode, type PasskeyRow, SESSION_NOT_FRESH } from "./passkey";
import { registerPasskey } from "./register-passkey";

// Idle-lock preference is per device (localStorage).
export function AutoLockCard() {
  const t = useTranslations("Settings");
  const { raw, setRaw, enabled, setEnabled } = useIdleTimeout();
  const { credentialId, markReady, clearReady } = useLockDevice();
  const platformAuthenticator = usePlatformAuthenticator();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  // The device credential may have been deleted on another device; drop the stale marker here.
  // Only the marker, never the lock: the user turned it on, and unlocking checks the keychain,
  // not this marker. Same queryKey as PasskeysCard, so the cache is shared.
  const listQuery = useQuery<PasskeyRow[]>({
    queryKey: ["passkeys"],
    queryFn: async () => (await authClient.passkey.listUserPasskeys()).data ?? [],
    enabled: credentialId != null,
  });
  const rows = listQuery.data;
  useEffect(() => {
    if (credentialId == null || !rows) return;
    // Never judge while fetching: right after registration the shared cache still holds the
    // pre-registration list, and the new credential would be cleared on the spot.
    if (listQuery.isFetching) return;
    if (!rows.some((r) => r.credentialID === credentialId)) clearReady();
  }, [credentialId, rows, listQuery.isFetching, clearReady]);

  // Turning on always re-proves presence (no shortcut via the stored marker). No extra confirm
  // dialog: the system biometric prompt already says it.
  function onToggle(next: boolean) {
    if (!next) {
      setEnabled(false);
      return;
    }
    void ensureDeviceCredential();
  }

  // Proves the person at this device can unlock, and gets that credential's id.
  // Verify first, register only if that fails: re-registering on a keychain that already has one is
  // rejected by excludeCredentials only after a system prompt, costing a second biometric check
  // (routine across iCloud-shared Mac/iPhone). The assertion's id is exactly the credential used.
  // Register with attachment "platform": otherwise a bystander could scan the cross-device QR and
  // the credential would land in *their* keychain.
  async function ensureDeviceCredential() {
    setBusy(true);
    try {
      const rows = (await authClient.passkey.listUserPasskeys().catch(() => null))?.data ?? [];
      if (rows.length > 0) {
        // Union type: the failure branch has no webauthn field, so narrow with `in`.
        const asserted = await signIn.passkey({ returnWebAuthnResponse: true });
        const usedId =
          asserted && "webauthn" in asserted ? asserted.webauthn?.response.id : undefined;
        if (usedId && !asserted?.error) {
          await claim(usedId);
          return;
        }
        // Failed: the account having passkeys doesn't mean this device does, so try registering.
      }
      const res = await registerPasskey("platform");
      if (res?.data) {
        await claim(res.data.credentialID);
        return;
      }
      // Only registration requires a fresh session, so not-fresh here means no passkeys at all and
      // a session older than a day: only re-signing in helps.
      const code = errorCode(res?.error);
      toast.error(
        code === SESSION_NOT_FRESH
          ? t("passkeyAddNeedsSignIn")
          : (res?.error?.message ?? t("autoLockEnableFailed")),
      );
    } catch {
      toast.error(t("autoLockEnableFailed")); // cancelled ceremony / no usable biometrics
    } finally {
      setBusy(false);
    }
  }

  // Invalidate before markReady: the shared cache still holds the pre-registration list, and the
  // stale-marker effect would clear the new credential. invalidateQueries awaits active refetches.
  async function claim(credId: string) {
    await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    markReady(credId);
    setEnabled(true);
    toast.success(t("autoLockEnabled"));
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{t("autoLock")}</CardTitle>
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            // Without biometrics a click opens the system "use another device" flow and then hangs
            // silently. null = still checking; don't disable yet to avoid a flash.
            disabled={busy || platformAuthenticator === false}
            ariaLabel={t("autoLock")}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-sm">{t("autoLockDesc")}</p>
          <p className="text-muted-foreground text-sm">{t("autoLockUnlock")}</p>
          {platformAuthenticator === false && (
            <p className="text-muted-foreground text-sm">{t("autoLockNoBiometrics")}</p>
          )}
          {/* Lock still applies; this device just has no registered credential. Toggling again
              re-verifies and binds one. */}
          {enabled && credentialId == null && platformAuthenticator !== false && (
            <p className="text-muted-foreground text-sm">{t("autoLockNoDeviceCredential")}</p>
          )}
        </div>
        {/* Greyed on the wrapper so the beUI Tabs internals stay untouched. */}
        <div
          className={cn(!enabled && "pointer-events-none opacity-50")}
          aria-disabled={!enabled || undefined}
        >
          <SettingRow label={t("autoLockAfter")}>
            <Tabs value={raw} onValueChange={setRaw} variant="pill">
              <TabsList className="bg-muted dark:bg-background">
                {IDLE_TIMEOUT_MINUTES.map((m) => (
                  <TabsTrigger key={m} value={String(m)}>
                    {m}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </SettingRow>
        </div>
      </CardContent>
    </Card>
  );
}

// Idle-lock registration is platform-only; without one the browser stalls on "use another device"
// with no error. null = unknown; defaulting to false would disable-then-enable on mount.
function usePlatformAuthenticator(): boolean | null {
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
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}
