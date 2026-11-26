import { Badge, Button, MorphingModal, SharedLayoutBg, toast } from "@folio/ui";
import { Plus, Trash2 } from "@folio/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { EditableName } from "@/components/editable-name";
import { IconButton } from "@/components/icon-button";
import { authClient, signIn } from "@/lib/core/auth-client";
import { useLockDevice } from "@/lib/hooks/use-lock-device";
import { SettingsSection } from "@/routes/_authed/-settings/settings-section";
import { errorCode, type PasskeyRow, SESSION_NOT_FRESH } from "./passkey";
import { getAuthenticatorName, type PasskeyKind, passkeyKind } from "./passkey-authenticators";
import { registerPasskey } from "./register-passkey";

const KIND_COPY = {
  synced: "passkeyKindSynced",
  platform: "passkeyKindPlatform",
  "security-key": "passkeyKindSecurityKey",
  "cross-device": "passkeyKindCrossDevice",
  unknown: null,
} as const satisfies Record<PasskeyKind, string | null>;

// Deleting every passkey is allowed: password sign-in is unaffected.
export function PasskeysCard() {
  const t = useTranslations("Settings");
  const locale = useLocale();
  const supported = usePasskeySupport();
  const [removing, setRemoving] = useState<PasskeyRow | null>(null);
  const [renaming, setRenaming] = useState<PasskeyRow | null>(null);
  const [adding, setAdding] = useState(false);
  const { credentialId: deviceCredentialId, clearReady } = useLockDevice();

  const passkeysQuery = useQuery<PasskeyRow[]>({
    queryKey: ["passkeys"],
    queryFn: async () => (await authClient.passkey.listUserPasskeys()).data ?? [],
    enabled: supported,
  });
  const passkeys = supported ? (passkeysQuery.data ?? null) : null;

  async function onAdd() {
    setAdding(true);
    try {
      let res = await registerPasskey();
      // Stale session: verifying refreshes it, then retry. Can't succeed with zero passkeys.
      if (errorCode(res?.error) === SESSION_NOT_FRESH) {
        const asserted = await signIn.passkey();
        if (!asserted?.data) {
          toast.error(t("passkeyAddNeedsSignIn"));
          return;
        }
        res = await registerPasskey();
      }
      if (res?.error) {
        toast.error(res.error.message ?? t("passkeyAddFailed"));
        return;
      }
      toast.success(t("passkeyAdded"));
      await passkeysQuery.refetch();
    } catch {
      toast.error(t("passkeyAddFailed"));
    } finally {
      setAdding(false);
    }
  }

  async function onRemove() {
    const pk = removing;
    setRemoving(null);
    if (!pk) return;
    const res = await authClient.passkey.deletePasskey({ id: pk.id });
    if (res?.error) {
      toast.error(res.error.message ?? t("passkeyRemoveFailed"));
      return;
    }
    toast.success(t("passkeyRemoved"));
    await passkeysQuery.refetch();
    // Removing this device's credential clears the marker only; the lock stays on.
    if (pk.credentialID === deviceCredentialId) clearReady();
  }

  const fmtDate = (d: string | Date) =>
    new Date(d).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

  const addButton = supported ? (
    <IconButton aria-label={t("addPasskey")} disabled={adding} onClick={onAdd}>
      <Plus />
    </IconButton>
  ) : null;

  const body = !supported ? (
    <p className="text-muted-foreground text-sm">{t("passkeyUnsupported")}</p>
  ) : (
    <PasskeysSupported
      passkeys={passkeys}
      renaming={renaming}
      deviceCredentialId={deviceCredentialId}
      fmtDate={fmtDate}
      onRename={setRenaming}
      onRemove={setRemoving}
      onRenamed={() => passkeysQuery.refetch()}
    />
  );

  return (
    <SettingsSection title={t("passkeys")} action={addButton}>
      {body}
      <RemovePasskeyModal
        removing={removing}
        onCancel={() => setRemoving(null)}
        onConfirm={onRemove}
      />
    </SettingsSection>
  );
}

function PasskeysSupported({
  passkeys,
  renaming,
  deviceCredentialId,
  fmtDate,
  onRename,
  onRemove,
  onRenamed,
}: {
  passkeys: PasskeyRow[] | null;
  renaming: PasskeyRow | null;
  deviceCredentialId: string | null;
  fmtDate: (d: string | Date) => string;
  onRename: (pk: PasskeyRow | null) => void;
  onRemove: (pk: PasskeyRow) => void;
  onRenamed: () => Promise<unknown>;
}) {
  const t = useTranslations("Settings");
  const list =
    passkeys && passkeys.length > 0 ? (
      <SharedLayoutBg className="gap-1" inset={0} pillClassName="rounded-lg bg-muted">
        {passkeys.map((pk) => (
          <PasskeyItem
            key={pk.id}
            pk={pk}
            editing={renaming?.id === pk.id}
            isThisDevice={pk.credentialID === deviceCredentialId}
            fmtDate={fmtDate}
            onRename={onRename}
            onRemove={onRemove}
            onRenamed={onRenamed}
          />
        ))}
      </SharedLayoutBg>
    ) : null;
  const empty =
    passkeys?.length === 0 ? (
      <p className="text-muted-foreground text-sm">{t("passkeysEmpty")}</p>
    ) : null;
  return (
    <>
      {list}
      {empty}
    </>
  );
}

function PasskeyItem({
  pk,
  editing,
  isThisDevice,
  fmtDate,
  onRename,
  onRemove,
  onRenamed,
}: {
  pk: PasskeyRow;
  editing: boolean;
  isThisDevice: boolean;
  fmtDate: (d: string | Date) => string;
  onRename: (pk: PasskeyRow | null) => void;
  onRemove: (pk: PasskeyRow) => void;
  onRenamed: () => Promise<unknown>;
}) {
  const t = useTranslations("Settings");
  const authName = getAuthenticatorName(pk.aaguid);
  const title = pk.name || authName || t("passkeyUnnamed");
  const kindKey = KIND_COPY[passkeyKind(pk)];
  const kindText = kindKey ? t(kindKey) : null;
  const addedText = t("passkeyAddedOn", { date: fmtDate(pk.createdAt) });
  const meta = [pk.name ? authName : null, kindText, addedText].filter(Boolean).join(" · ");
  const thisDeviceBadge =
    !editing && isThisDevice ? (
      <Badge status="info" size="sm" showIcon={false} className="shrink-0">
        {t("passkeyThisDevice")}
      </Badge>
    ) : null;
  const metaLine = !editing ? <div className="text-muted-foreground text-xs">{meta}</div> : null;
  const removeButton = !editing ? (
    <IconButton
      aria-label={t("removePasskey")}
      className="shrink-0 hover:bg-transparent hover:text-destructive"
      onClick={() => onRemove(pk)}
    >
      <Trash2 />
    </IconButton>
  ) : null;
  return (
    <div className="rounded-lg px-2 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex min-w-0 items-center gap-2">
            <EditableName
              value={pk.name ?? ""}
              editing={editing}
              onEditingChange={(e) => onRename(e ? pk : null)}
              onSave={async (name) => {
                const res = await authClient.passkey.updatePasskey({ id: pk.id, name });
                if (res?.error) {
                  toast.error(res.error.message ?? t("passkeyRenameFailed"));
                  throw new Error("rename failed");
                }
                await onRenamed();
              }}
              displayClassName="font-medium text-sm"
              placeholder={title}
            />
            {thisDeviceBadge}
          </div>
          {metaLine}
        </div>
        {removeButton}
      </div>
    </div>
  );
}

function RemovePasskeyModal({
  removing,
  onCancel,
  onConfirm,
}: {
  removing: PasskeyRow | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("Settings");
  const tc = useTranslations("Common");
  return (
    <MorphingModal viewId={removing ? "passkey-remove" : null} onClose={onCancel}>
      <div className="text-left">
        <p className="font-semibold text-base">{t("passkeyRemoveTitle")}</p>
        <p className="mt-2 text-muted-foreground text-sm">
          {t("passkeyRemoveBody", { name: removing?.name || t("passkeyUnnamed") })}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {tc("cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t("removePasskey")}
          </Button>
        </div>
      </div>
    </MorphingModal>
  );
}

// False during SSR/hydration; may flip true after mount.
function usePasskeySupport(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(typeof window !== "undefined" && !!window.PublicKeyCredential);
  }, []);
  return supported;
}
