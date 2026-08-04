import {
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  cn,
  Label,
  MorphingModal,
  Separator,
  SharedLayoutBg,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
} from "@folio/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import { LogOut, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { CurrencySwitcher } from "../../components/currency-switcher";
import { EditableName } from "../../components/editable-name";
import { useMountedTheme } from "../../hooks/use-theme";
import { type AccountUser, accountIdentity } from "../../lib/account-identity";
import { authClient, signIn, signOut } from "../../lib/auth-client";
import { clearIdleLockState } from "../../lib/hooks/use-idle-lock";
import { useIdleTimeout } from "../../lib/hooks/use-idle-timeout";
import { useLockDevice } from "../../lib/hooks/use-lock-device";
import { usePasskeySupport } from "../../lib/hooks/use-passkey-support";
import { LOCALE_COOKIE } from "../../lib/i18n/detect";
import { IDLE_TIMEOUT_MINUTES } from "../../lib/idle-lock";
import { importData } from "../../lib/import-data";
import { getAuthenticatorName, passkeyKind } from "../../lib/passkey-authenticators";
import { registerPasskey } from "../../lib/register-passkey";
import {
  getDataStats,
  getProviderKeyStatus,
  getValuationSettings,
  updateValuationSettings,
} from "../../lib/server/settings";
import type { Theme } from "../../lib/theme";

const authedApi = getRouteApi("/_authed");

export const Route = createFileRoute("/_authed/settings")({
  loader: async () => {
    const [status, valuation, dataStats] = await Promise.all([
      getProviderKeyStatus(),
      getValuationSettings(),
      getDataStats(),
    ]);
    return { status, valuation, dataStats };
  },
  component: Settings,
});

// 全局 provider key(品牌名不翻译);env 名是 getProviderKeyStatus 返回的 key。
// EVM 默认走 Rabby(不需要 key,所以不在这张表里);Zerion 是可选备源。
const PROVIDER_KEYS = [
  { env: "ZERION_API_KEY", label: "Zerion (EVM 备源,可不配)" },
  { env: "COINSTATS_API_KEY", label: "CoinStats (Solana / Sui / Cosmos)" },
] as const;

// 设置页(S1,#112):外观 / 账户 / 币种 / 登出全集中于此(外壳退回纯导航 + 身份)。
// 卡片顺序(grill):账户 → 外观 → Provider key → 估值 → 数据。
function Settings() {
  const { status, valuation, dataStats } = Route.useLoaderData();
  const { user } = authedApi.useRouteContext();
  return (
    <div className="flex flex-col gap-6">
      <AccountCard user={user} />
      <AppearanceCard />
      {/* 自动锁定在 passkeys 之前:passkey 现在**只从这里添加**(开关首次打开时注册一个本机凭据),
          下面那张卡退成纯列表/管理。顺序照着这条因果走。 */}
      <AutoLockCard />
      <PasskeysCard />
      <ProviderKeysCard status={status} />
      <ValuationCard mode={valuation.valuationMode} />
      <DataCard hasData={dataStats.hasData} />
    </div>
  );
}

// 标签左、控件右对齐的设置行(单行 justify-between)。
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  );
}

// 账户卡(置顶):身份行 + 登出;登出走 MorphingModal 二次确认(grill Q5)。
function AccountCard({ user }: { user: AccountUser }) {
  const t = useTranslations("Settings");
  const ts = useTranslations("Sidebar");
  const tc = useTranslations("Common");
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const id = accountIdentity(user);
  const secondary = id.secondary.kind === "email" ? id.secondary.value : ts("selfHosted");

  async function doSignOut() {
    // 与锁屏登出同理:不清闲置锁状态,重新登录会因旧 lastActive 已过期而当场被锁(#353)。
    clearIdleLockState();
    await signOut();
    navigate({ to: "/login" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("account")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-foreground text-sm">
              {id.initial}
            </div>
            <div className="min-w-0 leading-tight">
              <div className="truncate font-medium text-sm">{id.primary}</div>
              <div className="truncate text-muted-foreground text-sm">{secondary}</div>
            </div>
          </div>
          <Button variant="outline" onClick={() => setConfirmOpen(true)}>
            <LogOut className="size-4" />
            {t("signOut")}
          </Button>
        </div>
      </CardContent>

      <MorphingModal viewId={confirmOpen ? "signout" : null} onClose={() => setConfirmOpen(false)}>
        <div className="text-left">
          <p className="font-semibold text-base">{t("signOutConfirmTitle")}</p>
          <p className="mt-1.5 text-muted-foreground text-sm">{t("signOutConfirmBody")}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button variant="destructive" onClick={doSignOut}>
              {t("signOut")}
            </Button>
          </div>
        </div>
      </MorphingModal>
    </Card>
  );
}

// better-auth 的 error 是联合类型,只有部分分支带 code → 统一在这里取,免得每处都 in 判断一遍。
function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
}

/** 浏览器按 excludeCredentials 拒掉了重复注册 —— 这个认证器上已经有这个账户的凭据。 */
const PREVIOUSLY_REGISTERED = "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED";

/**
 * 注册 passkey 要求 session「新鲜」(better-auth 默认 freshAge = 1 天),而我们的 session 活 7 天
 * (`expiresIn`),于是登录满一天后所有添加动作一律 403「Session is not fresh」—— 与 localhost 无关,
 * 线上一样。
 *
 * **不把这个检查关掉**(`session.freshAge: 0`):它防的是 session 被偷之后悄悄挂一条 passkey 长期
 * 驻留 —— 那才是最坏的一种持久化。正确回应是让用户当场重新证明身份,而这刚好是我们手里就有的动作:
 * 验证一次(`verify-authentication` 不查 freshness,且成功后服务端会重建 session)。所以两个入口都是
 * 先验证、再继续,用户只多按一次指纹,没有任何一步需要他去理解「新鲜」这个词。
 */
const SESSION_NOT_FRESH = "SESSION_NOT_FRESH";

// 列表项:仅取渲染需要的字段(listUserPasskeys 返回的 Passkey 还含 publicKey 等,此处用不到)。
interface PasskeyRow {
  id: string; // better-auth 那行的主键 —— 重命名/删除接口收的是它
  credentialID: string; // WebAuthn 凭据 id —— 本机标记存的是它(见 idle-lock.ts),两者别混
  name?: string | null;
  createdAt: string | Date; // fetch 反序列化后可能是 string,渲染时统一 new Date()
  aaguid?: string | null; // 认证器型号标识 → 友好名
  backedUp?: boolean | null; // 是否云同步
  transports?: string | null; // 传输方式(internal/hybrid/usb…)→ 类型判定
}

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
  const { setEnabled: setIdleEnabled } = useIdleTimeout();

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
    // 删掉的正是本机那条 → 这台设备再没有解锁手段,连带关掉闲置锁(#353)。否则锁还开着却解不开,
    // 用户只剩登出一条路。
    //
    // 因为存的是 id 而不是布尔,这里能**精确**判断。早先用布尔时只能退而求「删光了才关」,那会漏掉
    // 「账户还剩别的设备的凭据、但本机那条被删了」这种情况;而「删任何一条都清标记」又会把人卡死 ——
    // better-auth 注册带 excludeCredentials,同一认证器重复注册会被浏览器拒掉,于是删了条无关的旧
    // 凭据就再也开不了锁。精确判断两头都避开了。
    if (pk.credentialID === deviceCredentialId) {
      clearReady();
      setIdleEnabled(false); // 关开关,不动时长 —— 重新启用时还是原来那个档
    }
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
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("addPasskey")}
              disabled={adding}
              onClick={onAdd}
              // 圆底:覆盖 size=icon 的 rounded-lg。hover 底也要覆盖 —— ghost 默认 bg-primary/5
              // 在暗色主题下肉眼几乎看不出来;用行 pill 同一个 token,视觉重量才对得上。
              className="rounded-full hover:bg-muted"
            >
              <Plus className="size-4" />
            </Button>
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
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("removePasskey")}
                            // 行本身已有 SharedLayoutBg 的 hover pill,图标再来一块底就是底叠底 →
                            // 只留变红。
                            className="shrink-0 hover:bg-transparent hover:text-destructive"
                            onClick={() => setRemoving(pk)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
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

// 外观卡:主题(三态 segmented)· 语言(中/EN segmented)· 币种(Select)。
// segmented = beUI Tabs(pill,仅 list,不挂 panel);中/EN 是语言自称,不本地化。
// 自动锁定卡(#292，ADR 0029)：闲置多久后遮住持仓。偏好每设备独立(localStorage)、改动即时生效。
export function AutoLockCard() {
  const t = useTranslations("Settings");
  const { raw, setRaw, enabled, setEnabled } = useIdleTimeout();
  const { credentialId, ready, markReady, clearReady } = useLockDevice();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  // 陈旧标记自纠(#353):本机那条凭据可能在**别的设备**上被删掉 —— 那边的删除动作管不到这里的
  // localStorage,于是本机标记还在、锁还开着,却已经没有凭据可解。进设置页时比对一次:存的
  // credentialID 不在账户列表里 → 清标记 + 关开关。查询与 PasskeysCard 同 key,共享缓存不多发请求。
  const listQuery = useQuery<PasskeyRow[]>({
    queryKey: ["passkeys"],
    queryFn: async () => (await authClient.passkey.listUserPasskeys()).data ?? [],
    enabled: credentialId != null,
  });
  const rows = listQuery.data;
  useEffect(() => {
    if (credentialId == null || !rows) return;
    // **正在拉取时绝不判**。这一行是 E2E 抓出来的(#354):刚注册完 markReady,这个 query 才第一次
    // enabled,而 PasskeysCard 用的是同一个 queryKey —— 缓存里已经躺着注册**之前**那份列表(不含新
    // 凭据)。于是 effect 立刻拿旧数据判定「标记指向的凭据不存在」,把刚建好的凭据当场清掉:开关
    // 弹回关闭、localStorage 空空,而认证器里明明多了一条。单元测试没抓到是因为它只挂一张卡,
    // 缓存里没有那份旧数据,rows 直接从 undefined 变成新列表。
    if (listQuery.isFetching) return;
    if (!rows.some((r) => r.credentialID === credentialId)) {
      clearReady();
      setEnabled(false); // 关开关,不动时长 —— 用户重新启用时还是原来那个档
    }
  }, [credentialId, rows, listQuery.isFetching, clearReady, setEnabled]);

  // 开关拨动:
  // ① 关 → 只移除开关键,时长与本机凭据记录都留着(所以再打开无须重新验证)。
  // ② 开且本机已有凭据 → 直接开,不走任何 WebAuthn。
  // ③ 开且本机没有凭据 → 当场做一次 ceremony 证明本机可解锁(见 ensureDeviceCredential)。
  //    不再弹二次确认:系统自己的指纹/面容弹窗已经把「要验一下」说清楚了,再套一层纯属多余一步。
  function onToggle(next: boolean) {
    if (!next) {
      setEnabled(false);
      return;
    }
    if (ready) {
      setEnabled(true);
      return;
    }
    void ensureDeviceCredential();
  }

  // 启用前置(#353):证明**这台设备**上有一条能解锁的凭据,拿到它的 credentialID 才算就绪。
  // 判据见 lib/idle-lock.ts 的 LOCK_DEVICE_PASSKEY_KEY。一次 ceremony,两条出口:
  //
  // ① 先试注册。authenticatorAttachment: "platform" 是关键 —— 不加的话系统会给「用其他设备」的
  //    二维码,别人在旁边扫一下就能让注册通过,而新凭据落在**他的**钥匙串里,这台设备照样解不开。
  //    设备名由 registerPasskey 事后补写(为什么不在注册时传见那个函数)。
  // ② 注册被拒(本机钥匙串里已有这个账户的凭据,excludeCredentials 拦下)→ 改成验证一次。
  //    这个错误本身就是证词「本机确实有一条可用凭据」,而 assertion 回的 id 就是这台设备实际用掉的
  //    那条 —— 比列数据库行去猜准。同一个 iCloud 下 Mac 与 iPhone 共享钥匙串,所以这条不是边角
  //    情况,而是换设备打开开关的**常规**路径。
  //    returnWebAuthnResponse 是唯一能拿到 credentialID 的口子(verify-authentication 只回 session)。
  async function ensureDeviceCredential() {
    setBusy(true);
    try {
      const res = await registerPasskey("platform");
      const err = res?.error;
      if (!err && res?.data) {
        await claim(res.data.credentialID);
        return;
      }
      // 两种失败都由「验证一次」接手,处理完全相同:
      // PREVIOUSLY_REGISTERED — 本机钥匙串里已有,注册进不去,但正好证明有;
      // SESSION_NOT_FRESH — 注册连 ceremony 都没跑到就被 403,验证既能刷新 session 又能拿到 id。
      const code = errorCode(err);
      if (code !== PREVIOUSLY_REGISTERED && code !== SESSION_NOT_FRESH) {
        toast.error(err?.message ?? t("autoLockEnableFailed"));
        return; // 注册没成、也不是这两种 → 开关不动,维持关闭
      }
      // 已登录时 better-auth 会把 allowCredentials 限定成当前用户的凭据,所以这次验证不可能验成
      // 别的账户;副作用是服务端会重建一次 session(同一用户,cookie 换新),与解锁时同款。
      // 返回是联合类型:失败那支根本没有 webauthn 字段 → 先 in 窄化再取。
      const asserted = await signIn.passkey({ returnWebAuthnResponse: true });
      const usedId =
        asserted && "webauthn" in asserted ? asserted.webauthn?.response.id : undefined;
      if (!usedId || asserted?.error) {
        toast.error(t("autoLockEnableFailed")); // 用户取消了验证
        return;
      }
      await claim(usedId);
    } catch {
      toast.error(t("autoLockEnableFailed")); // 用户取消 ceremony / 本机没有可用的生物识别
    } finally {
      setBusy(false);
    }
  }

  // 认下这台设备的凭据并开锁。
  //
  // **先刷列表、再写标记**,顺序要紧:下面那张 passkeys 卡用同一个 queryKey,缓存里此刻还是注册
  // 之前那份(不含新凭据)。反过来先 markReady 的话,上面那个自纠 effect 会拿旧列表判定「这条不
  // 存在」,当场把刚建好的凭据清掉 —— E2E 实测到的(#354),effect 那里也加了一道 isFetching 保护。
  // invalidateQueries 会等 active query 重新拉完,所以这一 await 之后缓存里已经有新凭据了。
  // (顺带也修了「注册成功但下面列表不显示」这个观感问题:两张卡不合并,但数据得连上。)
  async function claim(credId: string) {
    await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    markReady(credId);
    setEnabled(true);
    toast.success(t("autoLockEnabled"));
  }

  return (
    <Card>
      {/* 开关在右上角(标题同行)。开=启用闲置锁;下面的时长只在开着时可调。 */}
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{t("autoLock")}</CardTitle>
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={busy}
            ariaLabel={t("autoLock")}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          {/* 两行同一级说明,同色。曾经第二行是 text-foreground/80 提亮 —— 那时它写的是
              「用 passkey 或密码解锁」,提亮为的是强调解锁方式;密码那半在 #353 删掉后没这个必要了。 */}
          <p className="text-muted-foreground text-sm">{t("autoLockDesc")}</p>
          <p className="text-muted-foreground text-sm">{t("autoLockUnlock")}</p>
        </div>
        {/* 关着时时长行照样在,只是整行变灰且点不动 —— 让「这里有个设置,但要先打开」看得见。
            灰化包在外层 wrapper(pointer-events-none + opacity + aria-disabled),不动 beUI Tabs 内核。 */}
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

function AppearanceCard() {
  const t = useTranslations("Settings");
  const router = useRouter();
  const locale = useLocale();
  // 选中态用 useMountedTheme(SSR 安全):挂载前按 "system" 渲染避免 hydration mismatch + pill 硬跳,
  // 挂载后借 layoutId 平滑滑到位。语言走 cookie/SSR 一致,无需此处理。
  const { theme: themeValue, setTheme } = useMountedTheme();

  function setLocale(next: string) {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000`;
    router.invalidate();
  }

  return (
    // overflow-visible:覆盖 Card 默认的 overflow-hidden,否则币种 Select 的弹层(非 portal,
    // absolute 定位)会被卡片裁掉(#112 目视修正)。
    <Card className="overflow-visible">
      <CardHeader>
        <CardTitle>{t("appearance")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SettingRow label={t("theme")}>
          {/* 轨道底做成内凹:亮色卡是白,用 bg-muted(浅灰可见);暗色用 bg-background(比卡片更深)。保留默认 p-1。 */}
          <Tabs value={themeValue} onValueChange={(v) => setTheme(v as Theme)} variant="pill">
            <TabsList className="bg-muted dark:bg-background">
              <TabsTrigger value="light">{t("themeLight")}</TabsTrigger>
              <TabsTrigger value="dark">{t("themeDark")}</TabsTrigger>
              <TabsTrigger value="system">{t("themeSystem")}</TabsTrigger>
            </TabsList>
          </Tabs>
        </SettingRow>
        <SettingRow label={t("language")}>
          <Tabs value={locale} onValueChange={setLocale} variant="pill">
            <TabsList className="bg-muted dark:bg-background">
              <TabsTrigger value="zh">中</TabsTrigger>
              <TabsTrigger value="en">EN</TabsTrigger>
            </TabsList>
          </Tabs>
        </SettingRow>
        <SettingRow label={t("currency")}>
          <CurrencySwitcher />
        </SettingRow>
      </CardContent>
    </Card>
  );
}

function ProviderKeysCard({ status }: { status: Record<string, boolean> }) {
  const t = useTranslations("Settings");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("providerKeys")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {PROVIDER_KEYS.map((k) => (
            <li key={k.env} className="flex items-center justify-between">
              <span>{k.label}</span>
              <span className={status[k.env] ? "text-foreground" : "text-muted-foreground"}>
                {status[k.env] ? t("configured") : t("notConfigured")}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// 估值模式(Phase 3,#82):勾选 = source-first(统一采用市场源价);不勾 = self-first(默认)。
// 切换即写 user_settings + invalidate → 主页/图表现推立即改(历史冻结,无需重 sync)。
function ValuationCard({ mode }: { mode: "self-first" | "source-first" }) {
  const router = useRouter();
  const t = useTranslations("Settings");
  const [sourceFirst, setSourceFirst] = useState(mode === "source-first");
  const [busy, setBusy] = useState(false);

  async function onToggle(checked: boolean) {
    setSourceFirst(checked); // 乐观更新
    setBusy(true);
    try {
      await updateValuationSettings({ data: { mode: checked ? "source-first" : "self-first" } });
      await router.invalidate(); // 刷新总览/图表读路径
    } catch {
      setSourceFirst(!checked); // 回滚
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("valuation")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="valuation-source-first"
            checked={sourceFirst}
            disabled={busy}
            onCheckedChange={onToggle}
          />
          <Label htmlFor="valuation-source-first">{t("useSourcePrice")}</Label>
        </div>
        <p className="text-sm text-muted-foreground">{t("valuationHint")}</p>
      </CardContent>
    </Card>
  );
}

// 数据卡(合一):导出段 + 分隔线 + 导入段。复用现有 /api/export、/api/import 路由。
// 导入文案沿用 Accounts 命名空间的 import* 键(与账户页导入同源)。
function DataCard({ hasData }: { hasData: boolean }) {
  const router = useRouter();
  const t = useTranslations("Settings");
  const ta = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const inputRef = useRef<HTMLInputElement>(null);
  // 非空库导入是合并式(幂等,不翻倍),但先弹一道确认 —— 让用户明确知道是「并进已有数据」。
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  function clearInput() {
    if (inputRef.current) inputRef.current.value = "";
  }

  // 导入是「选了文件才发生一次的写」——用 useMutation 而非手搓 msg/error/busy 三个 state:
  // isPending 是单一事实源(直接接到 input/按钮的 disabled 上),连点两次也只跑一个;
  // 成功/失败各自的文案直接读 data/error,后回来的请求不会覆写前一条的状态(#241)。
  // 传输层抽在 lib/import-data(与仓里其它 mutation 一样调具名函数,不把 fetch 铺在组件里)。
  const importMutation = useMutation({
    mutationFn: importData,
    onSuccess: () => router.invalidate(), // 刷新列表读路径
    onSettled: clearInput, // 成败都清:让同一个文件能再选一次
  });

  function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (hasData) {
      setPendingFile(file); // 非空 → 先确认(见 MorphingModal),不立即导
      return;
    }
    importMutation.mutate(file); // 空库 → 直接导
  }

  function confirmImport() {
    const file = pendingFile;
    setPendingFile(null);
    if (file) importMutation.mutate(file);
  }

  function cancelImport() {
    setPendingFile(null);
    clearInput();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("data")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <p className="min-w-0 text-sm text-muted-foreground">{t("exportHint")}</p>
          <a
            href="/api/export"
            download
            className={buttonVariants({
              variant: "outline",
              className: "shrink-0 whitespace-nowrap",
            })}
          >
            {t("exportData")}
          </a>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4">
            <p className="min-w-0 text-sm text-muted-foreground">{ta("importHint")}</p>
            <input
              ref={inputRef}
              type="file"
              accept=".ndjson,application/x-ndjson,application/json"
              className="hidden"
              disabled={importMutation.isPending}
              onChange={onImportFile}
            />
            <Button
              type="button"
              variant="outline"
              disabled={importMutation.isPending}
              className="shrink-0 whitespace-nowrap"
              onClick={() => inputRef.current?.click()}
            >
              {importMutation.isPending ? tc("verifying") : ta("importBtn")}
            </Button>
          </div>
          {importMutation.isSuccess && (
            <p className="text-sm text-muted-foreground">
              {ta("imported", {
                accounts: importMutation.data.imported.accounts,
                snapshots: importMutation.data.imported.snapshots,
              })}
            </p>
          )}
          {importMutation.isError && (
            <p className="text-sm text-destructive">{importMutation.error.message}</p>
          )}
        </div>
      </CardContent>

      <MorphingModal viewId={pendingFile ? "import-merge" : null} onClose={cancelImport}>
        <div className="text-left">
          <p className="font-semibold text-base">{t("importMergeTitle")}</p>
          <p className="mt-1.5 text-muted-foreground text-sm">{t("importMergeBody")}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={cancelImport}>
              {tc("cancel")}
            </Button>
            <Button onClick={confirmImport}>{t("importMergeConfirm")}</Button>
          </div>
        </div>
      </MorphingModal>
    </Card>
  );
}
