import { Button } from "@folio/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fingerprint, LogOut } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { signIn, signOut } from "@/lib/core/auth-client";
import { clearIdleLockState, useIdleLock } from "@/lib/hooks/use-idle-lock";
import { useIdleTimeout } from "@/lib/hooks/use-idle-timeout";
import { useLockDevice } from "@/lib/hooks/use-lock-device";
import { AuthShell } from "@/routes/-login/auth-shell";

// 应用层闲置锁屏(ADR 0029 / #291）。父组件包裹 —— 锁定时**卸载 children**(不只是遮罩盖住):
// DOM 里不留内容,懂开发的人删掉遮罩也看不到底下数据。代价 = 组件本地态(滚动 / 展开 / 半填表单)丢失;
// 数据本身由更外层 QueryClient 缓存,重挂从缓存出、不重拉。防不住直接打 server fn / 读本机 D1(那层要
// 服务端锁),此层只封前端 DOM。逻辑在 useIdleLock hook;这里只管样子 + 解锁(复用 signIn,会话不销毁)。
//
// **解锁只认 passkey**(#353)。曾经还收账户密码,并特意为密码管理器代填做了隐藏 username +
// `current-password`(#289)—— 那条已删:浏览器记住密码后,进锁屏时密码已预填,任何人点一下就进去了,
// 与 ADR 0029 自己的威胁模型(防顺手偷看)直接冲突。密码是**登录**凭据,证明「我是谁」;解锁要的是
// **在场证明**,证明「此刻在键盘前的还是那个人」,被密码管理器代持的密码证明不了后者。
export function LockScreen({ children }: { children: ReactNode }) {
  const { timeoutMs, enabled } = useIdleTimeout();
  // 只看开关键这一道门,不过就纯透传 children(不挂 useIdleLock:整套活动监听 / 定时器 / 挂载比对
  // 都不进树)。「不锁」从「运行时到处判 null」升级为「根本不运行」,结构上消除整类漏判的误锁
  // (ADR 0029)。开关独立于时长,见 idle-lock.ts 的 IDLE_LOCK_ENABLED_KEY。
  //
  // **曾经还有第二道门:本机没有 passkey 记录就放行。已经取消。** 那条的理由是「宁可不锁也不能把人
  // 关在门外」,但它把判断做反了:锁是用户明确开的,而「本机记录没了」最常见的成因恰恰是清站点数据 ——
  // 也就是浏览器里最像「有人在动这台机器」的时刻,那时放行等于把持仓直接摊开。而「关在门外」本来
  // 就不成立:锁屏上一直有登出,登出重登就进来了(只读看板,登出没有破坏性)。所以宁可锁着。
  if (!enabled) return <>{children}</>;
  return <ActiveLockScreen timeoutMs={timeoutMs}>{children}</ActiveLockScreen>;
}

// 两道门都过了才挂:useIdleLock 在此子组件内无条件调用(符合 hooks 规则)。切到「永不」即
// 卸载本组件、清掉监听与定时器 —— 无需在 hook 里对 null 层层设防。
function ActiveLockScreen({ timeoutMs, children }: { timeoutMs: number; children: ReactNode }) {
  const { locked, unlock } = useIdleLock(timeoutMs);
  // 锁定 → 用锁屏**替换** children(卸载,不叠加):DOM 里不留内容,删遮罩也看不到底下数据。
  // 解锁重挂,数据从更外层 QueryClient 缓存出,不重拉;丢的只是组件本地态(滚动/展开/半填表单)。
  return locked ? <LockOverlay onUnlock={unlock} /> : children;
}

function LockOverlay({ onUnlock }: { onUnlock: () => void }) {
  const t = useTranslations("Lock");
  const tc = useTranslations("Common");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // 本机没有凭据记录时先说一句,别让人对着「解锁」按钮反复按。
  //
  // 按钮**照留**:记录没了不等于钥匙串里没有 —— 清站点数据只清 localStorage,平台上那条 passkey
  // 还在,解锁走的是系统的凭据选择、不看这个标记,所以按下去大概率还是能进。真进不去才走登出。
  const { ready } = useLockDevice();

  // 锁定期间锁住底层滚动:fixed 遮罩只是视觉盖住,滚轮/触摸会穿透(scroll chaining)到底下的
  // App。锁 html(文档滚动容器)+ body 双保险;LockOverlay 仅锁定时渲染,挂载即锁、卸载即还原。
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
      // signIn.passkey() 可能返回 undefined(用户取消 ceremony)。
      const res = await signIn.passkey();
      if (res?.error) setError(true);
      else onUnlock();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  // 逃生出口(#353):锁屏是全屏接管态,passkey 认不过去(换了设备、指纹识别不了、凭据被删)
  // 就没有任何出路 —— 得留一条「放我走」。**不加二次确认**:这里的登出是「我进不去了」的
  // 兜底,再挡一道反而添堵;误点的代价只是重登一次(只读看板,无破坏性操作)。settings
  // 那个登出加确认是因为它在日常界面里、误点概率高,语境不同。
  // 不清锁就「登出→登录→又锁上」成环;不清查询缓存,下一登录会看到上一份组合。
  async function onSignOut() {
    setBusy(true);
    clearIdleLockState();
    queryClient.clear();
    try {
      await signOut();
    } finally {
      navigate({ to: "/login" });
    }
  }

  return (
    // 接管态：盖住一切,无关闭按钮、点外部不关(登出是唯一出口)。复用 AuthShell(左上品牌 / 右上语言主题),
    // 背景=磨砂 blur 糊住底下 App;fixed 覆盖层定位由 className 传入。
    <AuthShell
      className="fixed inset-0 z-50"
      background={<div className="absolute inset-0 bg-background/50 backdrop-blur-md" />}
    >
      <div className="flex w-full max-w-sm flex-col gap-4">
        <p className="font-medium text-lg">{t("title")}</p>
        <p className="-mt-2 text-muted-foreground text-sm">{t("subtitle")}</p>
        {!ready && <p className="-mt-2 text-muted-foreground text-sm">{t("noDeviceCredential")}</p>}

        <Button type="button" className="w-full" disabled={busy} onClick={onPasskey}>
          <Fingerprint className="size-4" />
          {busy ? "…" : t("unlockWithPasskey")}
        </Button>
        {error ? <p className="text-destructive text-sm">{t("failed")}</p> : null}

        {/* 次级动作:ghost 弱化,不与「解锁」抢视觉 —— 这是出路,不是主路。 */}
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          disabled={busy}
          onClick={onSignOut}
        >
          <LogOut className="size-4" />
          {tc("signOut")}
        </Button>
      </div>
    </AuthShell>
  );
}
