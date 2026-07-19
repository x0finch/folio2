import { cn, Dock, DockItem, SharedLayoutBg } from "@folio/ui";
import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { BarChart3, Home, LogOut, Moon, Plus, Settings, Sun, Wallet } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { signOut } from "../lib/auth-client";
import { LOCALE_COOKIE } from "../lib/i18n/detect";
import type { Locale } from "../lib/i18n/messages";
import type { SyncStatusSummary } from "../lib/sync-status";
import { useTheme } from "../lib/theme";
import { AddAccountModal } from "./add-account-modal";
import { CurrencySwitcher } from "./currency-switcher";
import { Logo } from "./logo";
import { PageHeader } from "./page-header";
import { SyncStatus } from "./sync-status";

const NAVS = [
  { key: "overview", to: "/", icon: Home },
  { key: "accounts", to: "/accounts", icon: Wallet },
  { key: "insights", to: "/insights", icon: BarChart3 },
  { key: "settings", to: "/settings", icon: Settings },
] as const;

// 跟随 <html>.dark 反映当前深浅(主题在 <html> class 上,组件本地镜像一份)。
function useIsDark() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setDark(el.classList.contains("dark"));
    update();
    const obs = new MutationObserver(update);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

const CONTROL_BTN =
  "flex h-9 items-center justify-center rounded-lg border border-border bg-card-2 font-medium text-foreground text-sm transition-colors hover:bg-muted [&_svg]:size-4";

// 描边主题按钮(设计:☀/☾)。
function ThemeButton({ className }: { className?: string }) {
  const { setTheme } = useTheme();
  const dark = useIsDark();
  const ts = useTranslations("Sidebar");
  return (
    <button
      type="button"
      aria-label={ts("theme")}
      onClick={() => setTheme(dark ? "light" : "dark")}
      className={cn(CONTROL_BTN, className)}
    >
      {dark ? <Moon /> : <Sun />}
    </button>
  );
}

// 描边语言按钮(设计:中/EN)。切 cookie + invalidate 重跑根 loader → 换 locale。
function LangButton({ className }: { className?: string }) {
  const router = useRouter();
  const locale = useLocale();
  const ts = useTranslations("Sidebar");
  const next: Locale = locale === "zh" ? "en" : "zh";
  const set = () => {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000`;
    router.invalidate();
  };
  return (
    <button
      type="button"
      aria-label={ts("language")}
      onClick={set}
      className={cn(CONTROL_BTN, className)}
    >
      {locale === "zh" ? "中" : "EN"}
    </button>
  );
}

const SIGNOUT_BTN =
  "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4";

// 应用外壳(v2,#100 / ADR 0015):桌面常驻左侧栏 + 移动底部 Dock。
// 侧栏 active = 静态 bg(设计态)+ shared-layout-bg hover 滑动增强。
// 币种切换与 sign-out 暂留壳内(临时),#112 在 Settings 落地后移除。
export function AppShell({
  userName,
  syncStatus,
  children,
}: {
  userName: string;
  syncStatus: SyncStatusSummary;
  children: ReactNode;
}) {
  const t = useTranslations("Nav");
  const th = useTranslations("PageHeader");
  const ts = useTranslations("Sidebar");
  const tc = useTranslations("Common");
  const ta = useTranslations("Accounts");
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // 账户页:把「添加账户」融进全局同步钮的 + 段(受控 modal 在壳内渲染)。其余页无 action → 单枚同步 pill。
  const onAccounts = pathname.startsWith("/accounts");
  const [addOpen, setAddOpen] = useState(false);
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  const activeNav = NAVS.find((n) => isActive(n.to)) ?? NAVS[0];
  const pageTitle = t(activeNav.key);
  const pageSub =
    activeNav.key === "overview"
      ? th("overviewSub", { count: syncStatus.total })
      : th(`${activeNav.key}Sub` as "accountsSub" | "insightsSub" | "settingsSub");
  const initial = userName.trim().charAt(0).toUpperCase() || "?";

  const doSignOut = async () => {
    await signOut();
    navigate({ to: "/login" });
  };

  return (
    <div className="min-h-svh lg:flex">
      {/* 桌面常驻左侧栏 */}
      <aside className="hidden w-59 shrink-0 flex-col border-border border-r bg-card px-3.5 py-4.5 lg:sticky lg:top-0 lg:flex lg:h-svh lg:overflow-y-auto">
        <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-5">
          <Logo className="size-6 shrink-0" />
          <span className="font-semibold text-lg tracking-tight">folio</span>
        </div>

        <nav className="mt-4">
          <SharedLayoutBg className="gap-1" inset={0} pillClassName="rounded-lg bg-muted">
            {NAVS.map(({ key, to, icon: Icon }) => (
              <Link
                key={key}
                to={to}
                aria-current={isActive(to) ? "page" : undefined}
                className={cn(
                  "block rounded-lg px-3 py-2 font-medium text-sm transition-colors",
                  isActive(to)
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {/* icon+label 必须在内层 flex span:SharedLayoutBg 会把 children 塞进一个非 flex 的 z-10 div,
                    直接放 Link 上的 flex 作用不到 → 否则 icon/文字会竖排(见 #100 目视修正)。 */}
                <span className="flex items-center gap-3 [&_svg]:size-4">
                  <Icon />
                  {t(key)}
                </span>
              </Link>
            ))}
          </SharedLayoutBg>
        </nav>

        <div className="mt-auto flex flex-col gap-2.5 pt-4">
          <div className="flex gap-2">
            <ThemeButton className="flex-1" />
            <LangButton className="flex-1" />
          </div>
          <div className="flex items-center gap-2.5 px-1">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-foreground text-xs">
              {initial}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate font-medium text-xs">{userName}</div>
              <div className="text-muted-foreground text-xs">{ts("selfHosted")}</div>
            </div>
          </div>
          {/* 临时:币种 + 登出暂留壳内,#112 迁 Settings 后移除 */}
          <div className="flex items-center justify-between gap-2 px-1">
            <CurrencySwitcher />
            <button
              type="button"
              aria-label={tc("signOut")}
              onClick={doSignOut}
              className={SIGNOUT_BTN}
            >
              <LogOut />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动顶栏(桌面隐藏,控件在侧栏) */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-border border-b bg-background/80 px-4 py-3 backdrop-blur-xl lg:hidden">
          <div className="flex items-center gap-2.5">
            <Logo className="size-6 shrink-0" />
            <span className="font-semibold text-lg tracking-tight">folio</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ThemeButton className="w-9 px-0" />
            <LangButton className="w-9 px-0" />
            <CurrencySwitcher />
            <button
              type="button"
              aria-label={tc("signOut")}
              onClick={doSignOut}
              className={SIGNOUT_BTN}
            >
              <LogOut />
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-28 lg:px-8 lg:pb-10">
          <PageHeader
            title={pageTitle}
            subtitle={pageSub}
            actions={
              <SyncStatus
                summary={syncStatus}
                action={
                  onAccounts
                    ? {
                        icon: <Plus />,
                        label: ta("addAccount"),
                        onClick: () => setAddOpen(true),
                      }
                    : undefined
                }
              />
            }
          />
          {children}
          {/* 账户页专属:受控添加账户 modal(触发在全局同步钮的 + 段)。 */}
          {onAccounts && <AddAccountModal open={addOpen} onOpenChange={setAddOpen} />}
        </main>
      </div>

      {/* 移动底部悬浮 Dock 导航 */}
      <nav className="-translate-x-1/2 fixed bottom-5 left-1/2 z-40 lg:hidden">
        <Dock>
          {NAVS.map(({ key, to, icon: Icon }) => (
            <DockItem key={key} active={isActive(to)}>
              <Link
                to={to}
                aria-label={t(key)}
                className="flex size-full items-center justify-center"
              >
                <Icon className="size-5" />
              </Link>
            </DockItem>
          ))}
        </Dock>
      </nav>
    </div>
  );
}
