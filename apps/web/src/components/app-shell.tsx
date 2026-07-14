import { Dock, DockItem } from "@folio/ui";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { BarChart3, Home, LogOut, Moon, Settings, Sun, Wallet } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { signOut } from "../lib/auth-client";
import { useTheme } from "../lib/theme";
import { CurrencySwitcher } from "./currency-switcher";
import { LocaleSwitcher } from "./locale-switcher";
import { Logo } from "./logo";
import { PageHeader } from "./page-header";

const NAVS = [
  { key: "overview", to: "/", icon: Home },
  { key: "accounts", to: "/accounts", icon: Wallet },
  { key: "insights", to: "/insights", icon: BarChart3 },
  { key: "settings", to: "/settings", icon: Settings },
] as const;

// 深色开关:跟随 <html>.dark 显示日/月,点击在 light/dark 间切。
function ThemeToggle() {
  const { setTheme } = useTheme();
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setDark(el.classList.contains("dark"));
    update();
    const obs = new MutationObserver(update);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  const ts = useTranslations("Sidebar");
  return (
    <button
      type="button"
      aria-label={ts("theme")}
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4"
    >
      {dark ? <Moon /> : <Sun />}
    </button>
  );
}

// 应用外壳(v2 layout 骨架,#98 / ADR 0015):响应式二分 —— 桌面常驻左侧栏 + 移动底部 Dock。
// 每页顶部 PageHeader 承载标题(serif/副标题/同步入口由 H2 等后续切片接入)。
// active 滑块(shared-layout-bg)+ 身份 footer 打磨在 H1(#100)。
export function AppShell({ userName, children }: { userName: string; children: ReactNode }) {
  const t = useTranslations("Nav");
  const tc = useTranslations("Common");
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  const activeNav = NAVS.find((n) => isActive(n.to)) ?? NAVS[0];
  const pageTitle = t(activeNav.key);

  const doSignOut = async () => {
    await signOut();
    navigate({ to: "/login" });
  };

  return (
    <div className="min-h-svh lg:flex">
      {/* 桌面常驻左侧栏 */}
      <aside className="hidden w-59 shrink-0 flex-col border-border border-r bg-card p-3 lg:sticky lg:top-0 lg:flex lg:h-svh lg:overflow-y-auto">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <Logo className="size-6 shrink-0" />
          <span className="font-semibold text-lg tracking-tight">folio</span>
        </div>
        <nav className="mt-4 flex flex-col gap-1">
          {NAVS.map(({ key, to, icon: Icon }) => (
            <Link
              key={key}
              to={to}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 font-medium text-sm transition-colors [&_svg]:size-4 ${
                isActive(to)
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon />
              {t(key)}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 pt-4">
          <div className="flex items-center gap-1">
            <CurrencySwitcher />
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
          <div className="flex items-center justify-between gap-2 px-2">
            <span className="min-w-0 truncate text-muted-foreground text-xs">{userName}</span>
            <button
              type="button"
              aria-label={tc("signOut")}
              onClick={doSignOut}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4"
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
          <div className="flex items-center gap-1">
            <CurrencySwitcher />
            <LocaleSwitcher />
            <ThemeToggle />
            <button
              type="button"
              aria-label={tc("signOut")}
              onClick={doSignOut}
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4"
            >
              <LogOut />
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-28 lg:px-8 lg:pb-10">
          <PageHeader title={pageTitle} />
          {children}
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
