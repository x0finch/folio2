import { Button, cn, Input, Label, MorphingModal, Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { useNavigate } from "@tanstack/react-router";
import { Fingerprint } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

// 背景装饰用的假组合。登录页在 _authed 外,但 usePreferCurrency 有 USD 兜底,故可直接复用主页 hero。
// series 强上扬(末点最高)→ 面积图挂载时缓慢向上"画"出,且线终点顶到高处。用 sin 造确定性噪声
// (不用 Math.random),保证 SSR / 客户端一致、不触发 hydration mismatch。
const DEMO_SERIES: HistoryPoint[] = Array.from({ length: 28 }, (_, i) => ({
  t: i * DAY_MS,
  // 线性上扬 + 末段(约后 8 点)加速拉高 → 末点明显最高,呈"突破上涨"形。
  total: 150_000 + i * 3_600 + Math.max(0, i - 19) ** 2 * 900 + Math.sin(i * 0.9) * 3_500,
}));
const DEMO_START_TOTAL = 312_450.42;
// 24h 盈亏改口径之后(ADR 0040),hero 那个 pill 的数由 server 算好后传进来,不再从曲线上量 ——
// 所以演示数据也直接给一个正的盈亏,而不是靠「起点高于末值」间接凑出颜色。
const DEMO_GAIN = { amount: 4_820.15, pct: 1.57, segments: [] };
const DEMO_HOLDINGS: HoldingLike[] = [
  { token: { symbol: "BTC" }, totalValue: 112_400, gain24h: { amount: 2_310, pct: 2.1 } },
  { token: { symbol: "ETH" }, totalValue: 61_250, gain24h: { amount: 2_012, pct: 3.4 } },
  { token: { symbol: "SOL" }, totalValue: 20_000, gain24h: { amount: -243, pct: -1.2 } },
  { token: { symbol: "USDC" }, totalValue: 40_000, gain24h: { amount: 0, pct: 0 } },
];

// 登录页(L1 #113):主页净值 hero 喂假数据、放大虚化铺满全屏作背景;认证表单透明居中浮于其上。
export function LoginPage() {
  // 认证外壳(左上品牌 / 右上语言主题 / 居中表单)与锁屏共用;登录背景=虚化 hero。
  return (
    <AuthShell background={<HeroBackdrop />}>
      <AuthPanel />
      {/* read-only 信任说明:不套卡片,底部小字。 */}
      <ReadOnlyLine />
    </AuthShell>
  );
}

// 背景 hero:净值数字不定时小幅增长(NumberTicker 动画 → 不断盈利观感),chart 数据不变。
function HeroBackdrop() {
  const [total, setTotal] = useState(DEMO_START_TOTAL);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setTotal((v) => v + Math.round(50 + Math.random() * 250)); // 每次 +$50~$300
      timer = setTimeout(tick, 8_000 + Math.random() * 7_000); // 不定时:8~15s
    };
    timer = setTimeout(tick, 6_000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center overflow-hidden"
    >
      {/* 宽度 63vw × scale 1.6 ≈ 100.8vw 渲染宽(origin-left)→ 趋势铺满窗口宽、末点落在右缘。
          不加 px padding,否则内容被往里缩、两侧留白。 */}
      {/* contentClassName 只给文案层加左右 padding(数字/指标不贴边),趋势图仍满铺至窗口边缘。 */}
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

function AuthPanel() {
  const navigate = useNavigate();
  const t = useTranslations("Login");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 仅当浏览器支持 WebAuthn 时才露 passkey 入口;不支持则只留密码(见 ADR 0028)。
  const [supportsPasskey, setSupportsPasskey] = useState(false);
  // 密码登录/注册成功后,若该用户还没 passkey 且本设备没「别再问我」,弹一次引导(#285)。
  const [promptOpen, setPromptOpen] = useState(false);
  // 引导里加的 passkey 也要记进「本机凭据」,否则设置页的 auto-lock 会重复注册并被拒(见 onAddFromPrompt)。
  const { markReady } = useLockDevice();

  const isSignup = mode === "signup";

  // 邮箱认证成功后的落点:够条件则弹 passkey 引导(留在登录页等决定),否则直接进主页。
  async function afterEmailAuth() {
    if (supportsPasskey && !isPasskeyPromptDismissed()) {
      const res = await authClient.passkey.listUserPasskeys().catch(() => null);
      const passkeyCount = res?.data?.length ?? 0;
      if (shouldPromptForPasskey({ supported: true, dismissed: false, passkeyCount })) {
        setPromptOpen(true);
        return;
      }
    }
    navigate({ to: "/" });
  }

  // 引导里「添加」:走注册 ceremony;成败都进主页(引导是加分项,不该卡住登录)。
  //
  // 限定 platform + 记下 credentialID(#353)。**记它不是为了省掉之后那次验证** —— 拨开 auto-lock
  // 开关每次都会重验一遍,不看这条记录。它的用处是:设置页列表靠它标出「哪条是这台设备的」,删除时
  // 靠它精确判断要不要连带关锁。
  // (设置页 Passkeys 卡上那个加号是另一条路:不限 platform、也不记标记,见那里的注释。)
  //
  // 只记 id、**不打开闲置锁**:用户在这一步同意的是「加个 passkey 方便登录」,没同意「闲置就锁屏」。
  async function onAddFromPrompt() {
    setPromptOpen(false);
    // registerPasskey 顺带把设备名写进列表(供设置页识别,用户可随后改名);为什么不在注册时直接
    // 传 name 见那个函数的注释。
    const res = await registerPasskey("platform").catch(() => null);
    if (res?.data) markReady(res.data.credentialID);
    navigate({ to: "/" });
  }

  // 引导里「别再问我」:本设备记下,直接进主页。
  function onDismissPrompt() {
    dismissPasskeyPrompt();
    setPromptOpen(false);
    navigate({ to: "/" });
  }

  // 支持检测 + conditional-UI autofill:页面加载即静默发起 passkey autofill(浏览器把已注册的
  // passkey 填进邮箱框的建议里),用户选中即登录;不支持 conditional UI 的浏览器靠下方显式按钮兜底。
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
          if (!cancelled && res && !res.error) navigate({ to: "/" });
        });
      })
      .catch(() => {}); // autofill 失败/用户取消是常态,静默即可
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function onPasskey() {
    setError(null);
    setBusy(true);
    try {
      const res = await signIn.passkey();
      if (res?.error) {
        setError(res.error.message ?? t("authFailed"));
        return;
      }
      navigate({ to: "/" });
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
      // Name 未填时兜底取 email 的 @ 前本地部分(grill Q7),衔接 S1 userIdentity 身份行。
      const res = isSignup
        ? await signUp.email({ email, password, name: name.trim() || deriveDefaultName(email) })
        : await signIn.email({ email, password });
      if (res.error) {
        setError(res.error.message ?? t("authFailed"));
        return;
      }
      await afterEmailAuth();
    } catch {
      // 网络等异常(reject)也要落到错误态,否则 busy 卡死、用户无反馈。
      setError(t("authFailed"));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void submitEmailAuth();
  }

  // 密码管理器把邮箱+密码一起自动填好时,直接登录(免再点按钮)。只认「被 autofill」这一信号 ——
  // 手输永不触发(否则敲完密码那刻会被强行提交)。仅登录态、只触发一次(密码错→显示报错,不循环重试)。
  const autoSubmittedRef = useRef(false);
  const [autofilled, setAutofilled] = useState({ email: false, password: false });
  function onFieldAutofill(field: "email" | "password") {
    return (e: React.AnimationEvent) => {
      // 只认自定义探针动画(styles.css 的 input:-webkit-autofill),别把别处动画误判成填充。
      if (e.animationName === "folio-autofill") {
        setAutofilled((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
      }
    };
  }
  // submitEmailAuth 每次渲染新建、故意不入依赖:effect 随 autofilled/email/password 变化重跑时
  // 天然拿到最新闭包,autoSubmittedRef 保证只提交一次。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    if (isSignup || busy || autoSubmittedRef.current) return;
    if (!autofilled.email || !autofilled.password) return;
    // 等受控 state 追上 autofill 写进 DOM 的值(onChange 与 animationstart 时序可能错开)。
    if (!email || password.length < 8) return;
    autoSubmittedRef.current = true;
    void submitEmailAuth();
  }, [autofilled, email, password, isSignup, busy]);

  return (
    <div className="w-full max-w-sm">
      <p className="font-medium text-lg">{isSignup ? t("signUpTitle") : t("signInTitle")}</p>
      <p className="mt-1 mb-5 text-muted-foreground text-sm">{t("tagline")}</p>

      {/* 切换用 pill tabs,轨道贴合两项文字(不铺满,避免右侧空白)。 */}
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
          {/* autocomplete 含 webauthn(须为最后一个 token)→ 启用 conditional-UI passkey autofill。 */}
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

        {/* Name 在邮箱下方,随 signin/signup 平滑展开/收起(grid-rows 0fr↔1fr),避免高度突变跳动。
            收起时非交互(tabIndex -1)。 */}
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
          {/* 登录=current-password(触发填充),注册=new-password(触发「保存/生成密码」)。
              没配 passkey 的用户靠这个让密码管理器正确填充+提示保存。 */}
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
        {/* passkey 显式入口:仅登录态 + 浏览器支持时露(注册态还没账号,无意义)。 */}
        {!isSignup && supportsPasskey && (
          <Button type="button" variant="outline" disabled={busy} onClick={onPasskey}>
            <Fingerprint className="size-4" />
            {t("signInWithPasskey")}
          </Button>
        )}
      </form>

      {/* 登录后引导:关闭(点外)= 本次跳过(不持久),仍进主页。 */}
      <MorphingModal
        viewId={promptOpen ? "passkey-prompt" : null}
        onClose={() => {
          setPromptOpen(false);
          navigate({ to: "/" });
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
              <Fingerprint className="size-4" />
              {t("passkeyPromptAdd")}
            </Button>
          </div>
        </div>
      </MorphingModal>
    </div>
  );
}

// read-only 信任说明(grill Q4,改版:不套卡片,底部小字)。
function ReadOnlyLine() {
  const t = useTranslations("Login");
  return (
    <p className="absolute inset-x-0 bottom-5 z-10 px-6 text-center text-muted-foreground text-xs">
      {t("readOnlyHint")}
    </p>
  );
}
