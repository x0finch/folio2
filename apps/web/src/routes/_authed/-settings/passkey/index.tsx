import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  MorphingModal,
  SharedLayoutBg,
  toast,
} from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { EditableName } from "../../../../components/editable-name";
import { IconButton } from "../../../../components/icon-button";
import { authClient, signIn } from "../../../../lib/core/auth-client";
import { useLockDevice } from "../../../../lib/hooks/use-lock-device";
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

// Passkey 卡(#283 注册 + #284 管理):用 Face ID / Touch ID / 安全钥匙登录(首因子,与密码并列)。
// 仅浏览器支持 WebAuthn 时露入口。列表 / 重命名 / 删除全走 authClient.passkey.*(client 处理 WebAuthn
// ceremony,非 server fn);删除带二次确认。删光不影响密码登录,故无「至少留一个」下限。见 ADR 0028。
export function PasskeysCard() {
  const t = useTranslations("Settings");
  const locale = useLocale();
  const supported = usePasskeySupport();
  const [removing, setRemoving] = useState<PasskeyRow | null>(null);
  const [renaming, setRenaming] = useState<PasskeyRow | null>(null);
  const [adding, setAdding] = useState(false);
  const { credentialId: deviceCredentialId, clearReady } = useLockDevice();

  // 列表用 useQuery;supported 为真才拉。data undefined=加载中、[]=空。
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
      // session 过了新鲜期 → 验证一次刷新它,再重试注册。账户里一条 passkey 都没有时验证注定不成。
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
    // 删掉的正是本机那条 → 清掉本机标记。锁不跟着关。
    if (pk.credentialID === deviceCredentialId) clearReady();
  }

  const fmtDate = (d: string | Date) =>
    new Date(d).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

  const addButton = supported ? (
    <IconButton aria-label={t("addPasskey")} disabled={adding} onClick={onAdd}>
      <Plus className="size-4" />
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
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{t("passkeys")}</CardTitle>
          {addButton}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{body}</CardContent>
      <RemovePasskeyModal
        removing={removing}
        onCancel={() => setRemoving(null)}
        onConfirm={onRemove}
      />
    </Card>
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
  // SharedLayoutBg:hover 时 bg-muted pill 滑到当前行。inset=0 让 pill 贴合行宽。
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
      <p className="text-muted-foreground text-sm">{t("passkeysHint")}</p>
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
      <Trash2 className="size-4" />
    </IconButton>
  ) : null;
  return (
    <div className="rounded-lg px-2 py-1.5">
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
        <p className="mt-1.5 text-muted-foreground text-sm">
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

// 浏览器是否支持 WebAuthn。SSR / hydration：render 期恒 false，挂载后才可能置真。
function usePasskeySupport(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(typeof window !== "undefined" && !!window.PublicKeyCredential);
  }, []);
  return supported;
}
