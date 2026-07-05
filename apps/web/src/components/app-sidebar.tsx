import {
  Button,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@folio/ui";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { BarChart3, Home, LogOut, Moon, Settings, Sun, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { signOut } from "../lib/auth-client";
import { useTheme } from "../lib/theme";
import { LocaleSwitcher } from "./locale-switcher";

const NAVS = [
  { key: "overview", to: "/", icon: Home },
  { key: "accounts", to: "/accounts", icon: Wallet },
  { key: "insights", to: "/insights", icon: BarChart3 },
] as const;

// 深色开关(侧栏底部):跟随 <html>.dark 状态显示日/月,点击在 light/dark 间切。
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
    <Button
      variant="ghost"
      size="icon"
      aria-label={ts("theme")}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Moon /> : <Sun />}
    </Button>
  );
}

export function AppSidebar({ userName }: { userName: string }) {
  const t = useTranslations("Nav");
  const ts = useTranslations("Sidebar");
  const tc = useTranslations("Common");
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? ts("morning") : hour < 18 ? ts("afternoon") : ts("evening");

  return (
    <Sidebar variant="inset" className="border-r">
      <SidebarHeader>
        <div className="px-2 pt-4">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-4xl tracking-tight">folio</span>
            <span className="whitespace-pre-line border-border border-l-2 pl-2 text-muted-foreground text-xs">
              {ts("tagline")}
            </span>
          </div>
          <div className="mt-8 border-border border-b pb-4">
            <p className="font-medium text-accent-foreground text-sm">{greeting}</p>
            <p className="mt-0.5 text-muted-foreground text-sm">{userName}</p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-2 pt-2">
        <SidebarMenu>
          {NAVS.map(({ key, to, icon: Icon }) => (
            <SidebarMenuItem key={key}>
              <SidebarMenuButton isActive={isActive(to)} render={<Link to={to} />}>
                <Icon />
                <span>{t(key)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between px-1">
          <LocaleSwitcher />
          <ThemeToggle />
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={isActive("/settings")} render={<Link to="/settings" />}>
              <Settings />
              <span>{t("settings")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={async () => {
                await signOut();
                navigate({ to: "/login" });
              }}
            >
              <LogOut />
              <span>{tc("signOut")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
