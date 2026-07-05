import { CommandPalette, Dock, DockItem } from "@folio/ui";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  Home,
  LogOut,
  Moon,
  Search,
  Settings,
  Sun,
  SunMoon,
  Wallet,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { signOut } from "../lib/auth-client";
import { useTheme } from "../lib/theme";
import { LocaleSwitcher } from "./locale-switcher";
import { Logo } from "./logo";

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

  // 全局 ⌘K 启动器(复用 CommandPalette 外壳):导航跳转 + 设置 + 主题切换。静态清单,本地按 query 过滤。
  const { setTheme } = useTheme();
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkQuery, setCmdkQuery] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdkOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const commands = useMemo(
    () => [
      ...NAVS.map((n) => ({
        id: n.key,
        label: t(n.key),
        icon: n.icon,
        run: () => navigate({ to: n.to }),
      })),
      {
        id: "settings",
        label: t("settings"),
        icon: Settings,
        run: () => navigate({ to: "/settings" }),
      },
      {
        id: "theme",
        label: ts("theme"),
        icon: SunMoon,
        run: () => {
          const el = document.documentElement;
          setTheme(el.classList.contains("dark") ? "light" : "dark");
        },
      },
    ],
    [t, ts, navigate, setTheme],
  );
  const cmdkq = cmdkQuery.trim().toLowerCase();
  const filteredCmds = cmdkq
    ? commands.filter((c) => c.label.toLowerCase().includes(cmdkq))
    : commands;
  const runCmd = (run: () => void) => {
    run();
    setCmdkOpen(false);
    setCmdkQuery("");
  };

  return (
    <div className="min-h-svh">
      {/* 顶栏 */}
      <header className="sticky top-0 z-30 border-border border-b bg-background/80 backdrop-blur-xl">
        <div className="container mx-auto flex items-center justify-between gap-4 px-4 py-3 md:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <Logo className="size-6 shrink-0" />
            <span className="font-semibold text-2xl tracking-tight">folio</span>
            <span className="hidden truncate text-muted-foreground text-sm sm:block">
              {greeting}
              {userName ? `, ${userName}` : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setCmdkOpen(true)}
              aria-label="⌘K"
              className="mr-1 hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:text-foreground sm:inline-flex"
            >
              <Search className="size-3.5" />
              <kbd className="font-sans">⌘K</kbd>
            </button>
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

      {/* 全局 ⌘K 启动器 */}
      <CommandPalette
        open={cmdkOpen}
        onOpenChange={setCmdkOpen}
        query={cmdkQuery}
        onQueryChange={setCmdkQuery}
        placeholder={ts("commandPlaceholder")}
      >
        {filteredCmds.length > 0 ? (
          filteredCmds.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => runCmd(c.run)}
              className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground"
            >
              <c.icon />
              <span>{c.label}</span>
            </button>
          ))
        ) : (
          <div className="px-3 py-8 text-center text-muted-foreground text-sm">
            {ts("commandEmpty")}
          </div>
        )}
      </CommandPalette>
    </div>
  );
}
