import { Button, cn, Input, Label, MorphingModal, Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fingerprint, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { LocaleSwitcher } from "../components/locale-switcher";
import { Logo } from "../components/logo";
import { PortfolioHero } from "../components/portfolio-hero";
import { useMountedTheme } from "../hooks/use-theme";
import { authClient, signIn, signUp } from "../lib/auth-client";
import { deriveDefaultName } from "../lib/derive-default-name";
import type { HoldingLike } from "../lib/hero-stats";
import type { HistoryPoint } from "../lib/history";
import { detectDeviceLabel } from "../lib/passkey-authenticators";
import {
  dismissPasskeyPrompt,
  isPasskeyPromptDismissed,
  shouldPromptForPasskey,
} from "../lib/passkey-prompt";
import type { Theme } from "../lib/theme";

export const Route = createFileRoute("/login")({ component: LoginPage });

const DAY_MS = 86_400_000;

// 背景装饰用的假组合。登录页在 _authed 外,但 usePreferCurrency 有 USD 兜底,故可直接复用主页 hero。
// series 强上扬(末点最高)→ 面积图挂载时缓慢向上"画"出,且线终点顶到高处。用 sin 造确定性噪声
// (不用 Math.random),保证 SSR / 客户端一致、不触发 hydration mismatch。
const DEMO_SERIES: HistoryPoint[] = Array.from({ length: 28 }, (_, i) => ({
  t: i * DAY_MS,
  // 线性上扬 + 末段(约后 8 点)加速拉高 → 末点明显最高,呈"突破上涨"形。
  total: 150_000 + i * 3_600 + Math.max(0, i - 19) ** 2 * 900 + Math.sin(i * 0.9) * 3_500,
}));
// 显示净值起点须高于 DEMO_SERIES 末值(约 $302k),否则 hero 的 24h 变化算成负 → 红色 pill。
const DEMO_START_TOTAL = 312_450.42;
const DEMO_HOLDINGS: HoldingLike[] = [
  { token: { symbol: "BTC" }, totalValue: 112_400, change24h: 2.1 },
  { token: { symbol: "ETH" }, totalValue: 61_250, change24h: 3.4 },
  { token: { symbol: "SOL" }, totalValue: 20_000, change24h: -1.2 },
  { token: { symbol: "USDC" }, totalValue: 40_000, change24h: 0 },
];

// 登录页(L1 #113):主页净值 hero 喂假数据、放大虚化铺满全屏作背景;认证表单透明居中浮于其上。
function LoginPage() {
  return (
    <div className="relative min-h-screen w-full overflow-hidden">
      <HeroBackdrop />

      {/* 品牌固定在窗口左上角(复用侧栏的 Logo + folio 字标)。 */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-2.5">
        <Logo className="size-6 shrink-0" />
        <span className="font-semibold text-lg tracking-tight">folio</span>
      </div>

      {/* 全局切换固定在窗口右上角。 */}
      <div className="absolute top-4 right-4 z-20 flex items-center gap-4">
        <LocaleSwitcher />
        <ThemeToggle />
      </div>

      {/* 前景:透明、不套卡片的认证表单,居中。 */}
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center p-6">
        <AuthPanel />
      </div>

      {/* read-only 信任说明:不套卡片,底部小字。 */}
      <ReadOnlyLine />
    </div>
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
  async function onAddFromPrompt() {
    setPromptOpen(false);
    // 默认名 = 当前浏览器/系统(添加时这台),供设置页列表识别;用户可随后改名。
    await authClient.passkey
      .addPasskey({ name: detectDeviceLabel(navigator.userAgent) })
      .catch(() => null);
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
      // Name 未填时兜底取 email 的 @ 前本地部分(grill Q7),衔接 S1 accountIdentity 身份行。
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

// 主题切换:单 icon 循环 light → dark → system(icon 反映当前态)。选中态用 useMountedTheme(SSR 安全)。
const THEME_ORDER: Theme[] = ["light", "dark", "system"];
const THEME_ICON: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

function ThemeToggle() {
  const { theme, setTheme } = useMountedTheme();
  const Icon = THEME_ICON[theme];
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  return (
    <button
      type="button"
      aria-label={`theme: ${theme}`}
      onClick={() => setTheme(next)}
      className="text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon className="size-4" />
    </button>
  );
}
