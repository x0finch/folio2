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
import { authClient, signIn } from "../../../../lib/core/auth-client";
import { IDLE_TIMEOUT_MINUTES } from "../../../../lib/hooks/idle-lock";
import { useIdleTimeout } from "../../../../lib/hooks/use-idle-timeout";
import { useLockDevice } from "../../../../lib/hooks/use-lock-device";
import { registerPasskey } from "../../../../lib/register-passkey";
import { SettingRow } from "../setting-row";
import { errorCode, type PasskeyRow, SESSION_NOT_FRESH } from "./passkey";

// 自动锁定卡(#292，ADR 0029)：闲置多久后遮住持仓。偏好每设备独立(localStorage)、改动即时生效。
export function AutoLockCard() {
  const t = useTranslations("Settings");
  const { raw, setRaw, enabled, setEnabled } = useIdleTimeout();
  const { credentialId, markReady, clearReady } = useLockDevice();
  const platformAuthenticator = usePlatformAuthenticator();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  // 陈旧标记自纠(#353):本机那条凭据可能在**别的设备**上被删掉 —— 那边的删除动作管不到这里的
  // localStorage,于是本机标记还在,指着一条已经不存在的凭据。进设置页时比对一次,不在账户列表里
  // 就清掉标记。查询与 PasskeysCard 同 key,共享缓存不多发请求。
  //
  // **只清标记,不关锁。** 早先这里连带 setEnabled(false):凭据没了就自动放行。那是把判断做反了 ——
  // 锁是用户明确开的,系统无权替他撤;而且解锁看的是系统钥匙串里有没有可用凭据,不是这个标记,
  // 标记过期不等于解不开。真解不开也不算被关在门外:锁屏上有登出,登出重登即可。
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
    if (!rows.some((r) => r.credentialID === credentialId)) clearReady();
  }, [credentialId, rows, listQuery.isFetching, clearReady]);

  // 开关拨动。关 → 只移除开关键,时长与本机凭据记录都留着(重新打开时时长还是原来那个档)。
  // 开 → **每次都当场证明一遍在场**,不看本地有没有记录、不设捷径(见 ensureDeviceCredential)。
  // 不弹自家的二次确认:系统的指纹/面容弹窗已经把「要验一下」说清楚了,再套一层纯属多余一步。
  function onToggle(next: boolean) {
    if (!next) {
      setEnabled(false);
      return;
    }
    void ensureDeviceCredential();
  }

  // 启用前置(#353):证明**此刻在这台设备上的人**能解锁,并拿到那条凭据的 credentialID。
  // 判据见 lib/idle-lock.ts 的 LOCK_DEVICE_PASSKEY_KEY。
  //
  // **先验证,验证不成才注册** —— 顺序是这样定的:
  //
  // ① 账户里已经有 passkey → 先验证。这台设备的钥匙串里如果确实有一条,一次系统弹窗就够,而且
  //    assertion 回的 id 必然是这台设备**实际用掉**的那条,比从数据库列表里猜准。
  //    反过来先注册的话:同一个钥匙串上重复注册会被 excludeCredentials 拒(better-auth 服务端硬编码),
  //    而平台通常是**先弹一次系统窗口、验完才告诉你「已经有了」**,于是用户白按一次指纹、再被要求验
  //    第二次。同一个 iCloud 下 Mac 与 iPhone 共享钥匙串,这不是边角情况,而是常规路径。
  //    returnWebAuthnResponse 是唯一能拿到 credentialID 的口子(verify-authentication 只回 session)。
  //    已登录时 better-auth 把 allowCredentials 限定成当前用户的凭据,所以这次验证不可能验成别的
  //    账户;副作用是服务端重建一次 session(同一用户,cookie 换新),与解锁时同款。
  //
  // ② 账户里没有 passkey,或者验证没过(可能这台设备的钥匙串里根本没有 —— 账户的凭据都在别人
  //    设备上)→ 注册一条本机的。`authenticatorAttachment: "platform"` 是关键:不加的话系统会给
  //    「用其他设备」的二维码,别人在旁边扫一下就能让注册通过,而新凭据落在**他的**钥匙串里,
  //    这台设备照样解不开。设备名由 registerPasskey 事后补写(为什么不在注册时传见那个函数)。
  //
  // **每次开启都跑一遍**,哪怕本地已有凭据记录:开启闲置锁是把「遮住持仓」这件事交给生物识别,
  // 该由此刻在键盘前的人证明自己,而不是由一条上次留下的 localStorage 记录代劳。
  async function ensureDeviceCredential() {
    setBusy(true);
    try {
      const rows = (await authClient.passkey.listUserPasskeys().catch(() => null))?.data ?? [];
      if (rows.length > 0) {
        // 返回是联合类型:失败那支根本没有 webauthn 字段 → 先 in 窄化再取。
        const asserted = await signIn.passkey({ returnWebAuthnResponse: true });
        const usedId =
          asserted && "webauthn" in asserted ? asserted.webauthn?.response.id : undefined;
        if (usedId && !asserted?.error) {
          await claim(usedId);
          return;
        }
        // 验证没过 → 不在这里收手,往下试注册:账户有 passkey 不等于**这台**设备有。
      }
      const res = await registerPasskey("platform");
      if (res?.data) {
        await claim(res.data.credentialID);
        return;
      }
      // 注册要求 session 新鲜,而验证不要求 —— 所以走到这里还撞上 not-fresh,只可能是账户压根
      // 没有 passkey(上面那一支没进)且登录已超过一天。这种只能让用户重新登录,再试也没用。
      const code = errorCode(res?.error);
      toast.error(
        code === SESSION_NOT_FRESH
          ? t("passkeyAddNeedsSignIn")
          : (res?.error?.message ?? t("autoLockEnableFailed")),
      );
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

  // 开关就是开关键本身。曾经这里写 `enabled && credentialId != null` —— 那时 LockScreen 要两者都在
  // 才上锁,开关得说实话。现在没有第二道门了:开关键在,就是真在锁,所以两者同一件事。

  return (
    <Card>
      {/* 开关在右上角(标题同行)。开=启用闲置锁;下面的时长只在开着时可调。 */}
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{t("autoLock")}</CardTitle>
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            // 这台机器没有指纹/面容时禁掉:留着的话点下去只会弹出系统的「用其他设备」界面然后毫无
            // 反应(ceremony 挂着不返回,连失败提示都没有)。null = 还在问,先不禁免得闪。
            disabled={busy || platformAuthenticator === false}
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
          {/* 开不了的时候必须说清为什么,否则就是「点了没反应」。 */}
          {platformAuthenticator === false && (
            <p className="text-muted-foreground text-sm">{t("autoLockNoBiometrics")}</p>
          )}
          {/* 开关键还在、凭据记录没了(清过站点数据 / 在别处删了那条凭据):**锁照旧生效**,只是这台
              设备上没有登记在册的解锁凭据了。得说一声怎么办 —— 再拨一次开关就会重新验证并绑定。 */}
          {enabled && credentialId == null && platformAuthenticator !== false && (
            <p className="text-muted-foreground text-sm">{t("autoLockNoDeviceCredential")}</p>
          )}
        </div>
        {/* 没在锁的时候时长行照样在,只是整行变灰且点不动 —— 让「这里有个设置,但要先打开」看得见。
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

// 这台机器有没有可做用户验证的平台认证器(Touch ID / Face ID / Windows Hello)。
// 闲置锁注册限定 platform；没有时浏览器会停在「用其他设备」不报错(#354)。
// null = 还没问出来；用 false 兜底会让开关挂载瞬间先禁用再启用。
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
