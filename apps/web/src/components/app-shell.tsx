import { Dock, DockItem } from "@folio/ui";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { BarChart3, Home, LogOut, Moon, Settings, Sun, Wallet } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { signOut } from "../lib/auth-client";
import { useTheme } from "../lib/theme";
import { LocaleSwitcher } from "./locale-switcher";

const NAVS = [
  { key: "overview", to: "/", icon: Home },
  { key: "accounts", to: "/accounts", icon: Wallet },
  { key: "insights", to: "/insights", icon: BarChart3 },
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

// 应用外壳(beui #08):顶栏(品牌 + 问候 + 工具簇)+ 内容区 + 底部悬浮 Dock 导航。
// 弃常驻左栏/off-canvas;移动端 = 精简顶栏 + 底部 Dock。
export function AppShell({ userName, children }: { userName: string; children: ReactNode }) {
  const t = useTranslations("Nav");
  const ts = useTranslations("Sidebar");
  const tc = useTranslations("Common");
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? ts("morning") : hour < 18 ? ts("afternoon") : ts("evening");

  return (
    <div className="min-h-svh">
      {/* 顶栏 */}
      <header className="sticky top-0 z-30 border-border border-b bg-background/80 backdrop-blur-xl">
        <div className="container mx-auto flex items-center justify-between gap-4 px-4 py-3 md:px-8">
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="font-semibold text-2xl tracking-tight">folio</span>
            <span className="hidden truncate text-muted-foreground text-sm sm:block">
              {greeting}
              {userName ? `, ${userName}` : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <LocaleSwitcher />
            <ThemeToggle />
            <Link
              to="/settings"
              aria-label={t("settings")}
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4"
            >
              <Settings />
            </Link>
            <button
              type="button"
              aria-label={tc("signOut")}
              onClick={async () => {
                await signOut();
                navigate({ to: "/login" });
              }}
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4"
            >
              <LogOut />
            </button>
          </div>
        </div>
      </header>

      {/* 内容区:底部留白避开悬浮 Dock */}
      <main className="container mx-auto px-4 pt-6 pb-28 md:px-8">{children}</main>

      {/* 底部悬浮 Dock 导航 */}
      <nav className="-translate-x-1/2 fixed bottom-5 left-1/2 z-40">
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
