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
import { useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { EditableName } from "../../../components/editable-name";
import { IconButton } from "../../../components/icon-button";
import { authClient, signIn } from "../../../lib/auth-client";
import { useLockDevice } from "../../../lib/hooks/use-lock-device";
import { usePasskeySupport } from "../../../lib/hooks/use-passkey-support";
import { getAuthenticatorName, passkeyKind } from "../../../lib/passkey-authenticators";
import { registerPasskey } from "../../../lib/register-passkey";
import type { PasskeyRow } from "./passkey-row";
import { errorCode, SESSION_NOT_FRESH } from "./passkey-session";

// Passkey 卡(#283 注册 + #284 管理):用 Face ID / Touch ID / 安全钥匙登录(首因子,与密码并列)。
// 仅浏览器支持 WebAuthn 时露入口。列表 / 重命名 / 删除全走 authClient.passkey.*(client 处理 WebAuthn
// ceremony,非 server fn);删除带二次确认。删光不影响密码登录,故无「至少留一个」下限。见 ADR 0028。
// 导出供测试:这两张卡有真实的相互依赖(共享本机 passkey id + 同一个 passkeys 查询),
// 而它们的关键分支(注册必须限定 platform、删对了才关锁)值得单测钉住 —— 见 tests/settings-passkey-lock.test.tsx。
export function PasskeysCard() {
  const t = useTranslations("Settings");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const supported = usePasskeySupport();
  const [removing, setRemoving] = useState<PasskeyRow | null>(null);
  const [renaming, setRenaming] = useState<PasskeyRow | null>(null);
  const [adding, setAdding] = useState(false);
  // 本机那条凭据的 credentialID:列表靠它标「这台设备」,删除时靠它精确判断要不要连带关锁(见 onRemove)。
  const { credentialId: deviceCredentialId, clearReady } = useLockDevice();

  // 列表用 useQuery(与 account-detail-sheet 一致);supported 为真才拉。data undefined=加载中、[]=空。
  const passkeysQuery = useQuery<PasskeyRow[]>({
    queryKey: ["passkeys"],
    queryFn: async () => (await authClient.passkey.listUserPasskeys()).data ?? [],
    enabled: supported,
  });
  const passkeys = supported ? (passkeysQuery.data ?? null) : null; // null = 加载中

  // 纯登录用的添加入口(#353)。与自动锁定那条**刻意不同**:这里不限 authenticatorAttachment ——
  // 硬件安全钥匙、别的设备扫码都允许,因为只要能登录就有用。也正因为凭据不一定在本机,这里
  // **不写本机标记、不动闲置锁**:那个标记的含义是「这台设备能解锁」,这条路证明不了。
  async function onAdd() {
    setAdding(true);
    try {
      let res = await registerPasskey();
      // session 过了新鲜期(见 SESSION_NOT_FRESH)→ 验证一次刷新它,再重试注册。账户里一条 passkey
      // 都没有时验证注定不成(没有可用的凭据可选),那就只能让用户重新登录。
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
      toast.error(t("passkeyAddFailed")); // 用户取消 ceremony
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
    // 删掉的正是本机那条 → 清掉本机标记(#353)。**锁不跟着关**:锁是用户明确开的,删一条凭据不代表
    // 他要撤掉锁;真解不开也有登出这条路,登出重登即可。设置页那句提示会告诉他怎么恢复。
    //
    // 因为存的是 id 而不是布尔,这里能**精确**判断。早先用布尔时只能退而求「删光了才关」,那会漏掉
    // 「账户还剩别的设备的凭据、但本机那条被删了」这种情况;而「删任何一条都清标记」又会把人卡死 ——
    // better-auth 注册带 excludeCredentials,同一认证器重复注册会被浏览器拒掉,于是删了条无关的旧
    // 凭据就再也开不了锁。精确判断两头都避开了。
    if (pk.credentialID === deviceCredentialId) clearReady();
  }

  const fmtDate = (d: string | Date) =>
    new Date(d).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

  return (
    <Card>
      {/* 加号在右上角(与自动锁定那张卡的开关同位置)。只在浏览器支持 passkey 时露 —— 不支持时
          点了必然失败。 */}
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{t("passkeys")}</CardTitle>
          {supported && (
            <IconButton aria-label={t("addPasskey")} disabled={adding} onClick={onAdd}>
              <Plus className="size-4" />
            </IconButton>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!supported ? (
          <p className="text-muted-foreground text-sm">{t("passkeyUnsupported")}</p>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">{t("passkeysHint")}</p>
            {/* SharedLayoutBg:hover 时 bg-muted pill 滑到当前行(同侧栏导航)。inset=0 让 pill 贴合行宽。 */}
            {passkeys && passkeys.length > 0 && (
              <SharedLayoutBg className="gap-1" inset={0} pillClassName="rounded-lg bg-muted">
                {passkeys.map((pk) => {
                  // 标题:用户命名/注册时设备名 → 认证器友好名(aaguid) → 通用「Passkey」。
                  const authName = getAuthenticatorName(pk.aaguid);
                  const title = pk.name || authName || t("passkeyUnnamed");
                  // 副标题:认证器名(仅当没被标题用掉,即标题已是 name 时)+ 类型/同步标 + 添加时间。
                  const kind = passkeyKind(pk);
                  const kindText =
                    kind === "synced"
                      ? t("passkeyKindSynced")
                      : kind === "platform"
                        ? t("passkeyKindPlatform")
                        : kind === "security-key"
                          ? t("passkeyKindSecurityKey")
                          : kind === "cross-device"
                            ? t("passkeyKindCrossDevice")
                            : null;
                  const addedText = t("passkeyAddedOn", { date: fmtDate(pk.createdAt) });
                  const meta = [pk.name ? authName : null, kindText, addedText]
                    .filter(Boolean)
                    .join(" · ");
                  const isEditing = renaming?.id === pk.id;
                  return (
                    // 外层是 SharedLayoutBg 的「行」(pill 滑到这);内容包一层 flex —— SharedLayoutBg 会把
                    // children 塞进一个非 flex 的 z-10 div,直接用 flex 作用不到(同 app-shell 侧栏)。
                    <div key={pk.id} className="rounded-lg px-2 py-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1 leading-tight">
                          {/* 名字与「这台设备」badge 同行:badge 独占一行会把这条撑高、跟别的行不齐。
                              badge 的判据是拿本机存的 passkey id 跟每行比 —— 账户里哪条是自己这台机器
                              上的,列表本来看不出来(passkey 可跨设备同步、名字还能改)。 */}
                          <div className="flex min-w-0 items-center gap-2">
                            {/* 就地重命名(与账户详情头部同一组件)。placeholder 用认证器友好名。 */}
                            <EditableName
                              value={pk.name ?? ""}
                              editing={isEditing}
                              onEditingChange={(e) => setRenaming(e ? pk : null)}
                              onSave={async (name) => {
                                const res = await authClient.passkey.updatePasskey({
                                  id: pk.id,
                                  name,
                                });
                                if (res?.error) {
                                  toast.error(res.error.message ?? t("passkeyRenameFailed"));
                                  throw new Error("rename failed"); // 保持编辑态
                                }
                                await passkeysQuery.refetch();
                              }}
                              displayClassName="font-medium text-sm"
                              placeholder={title}
                            />
                            {!isEditing && pk.credentialID === deviceCredentialId && (
                              <Badge status="info" size="sm" showIcon={false} className="shrink-0">
                                {t("passkeyThisDevice")}
                              </Badge>
                            )}
                          </div>
                          {!isEditing && (
                            <div className="text-muted-foreground text-xs">{meta}</div>
                          )}
                        </div>
                        {!isEditing && (
                          <IconButton
                            aria-label={t("removePasskey")}
                            // 行本身已有 SharedLayoutBg 的 hover pill,图标再来一块底就是底叠底 →
                            // 只留变红。
                            className="shrink-0 hover:bg-transparent hover:text-destructive"
                            onClick={() => setRemoving(pk)}
                          >
                            <Trash2 className="size-4" />
                          </IconButton>
                        )}
                      </div>
                    </div>
                  );
                })}
              </SharedLayoutBg>
            )}
            {passkeys?.length === 0 && (
              <p className="text-muted-foreground text-sm">{t("passkeysEmpty")}</p>
            )}
          </>
        )}
      </CardContent>

      {/* 删除确认(丢设备要能撤销 → 删后该 passkey 不能再登录)。 */}
      <MorphingModal viewId={removing ? "passkey-remove" : null} onClose={() => setRemoving(null)}>
        <div className="text-left">
          <p className="font-semibold text-base">{t("passkeyRemoveTitle")}</p>
          <p className="mt-1.5 text-muted-foreground text-sm">
            {t("passkeyRemoveBody", { name: removing?.name || t("passkeyUnnamed") })}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRemoving(null)}>
              {tc("cancel")}
            </Button>
            <Button variant="destructive" onClick={onRemove}>
              {t("removePasskey")}
            </Button>
          </div>
        </div>
      </MorphingModal>
    </Card>
  );
}
