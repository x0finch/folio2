import { cn, Dock, DockItem, SharedLayoutBg } from "@folio/ui";
import { Link, useRouterState } from "@tanstack/react-router";
import { BarChart3, Home, Settings, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import type { SyncStatusSummary } from "../lib/sync-status";
import { Logo } from "./logo";
import { PageHeader } from "./page-header";

const NAVS = [
  { key: "overview", to: "/", icon: Home },
  { key: "accounts", to: "/accounts", icon: Wallet },
  { key: "insights", to: "/insights", icon: BarChart3 },
  { key: "settings", to: "/settings", icon: Settings },
] as const;

// 应用外壳(v2,#100 / ADR 0015):桌面常驻左侧栏 + 移动底部 Dock。
// 外观 / 语言 / 币种 / 登出集中于 Settings(#112)——外壳只做导航 + 身份展示。
// 侧栏 active = 静态 bg(设计态)+ shared-layout-bg hover 滑动增强。
export function AppShell({
  userName,
  syncStatus,
  selector,
  children,
}: {
  userName: string;
  syncStatus: SyncStatusSummary;
  // 全局 Portfolio 选择器(ADR 0033):住布局层,主页/账户页/Insights 共享;Settings 页不显示。
  // 组件自身在 <2 个 Portfolio 时不渲染(渐进式显示)。
  selector?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("Nav");
  const th = useTranslations("PageHeader");
  const ts = useTranslations("Sidebar");
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  const activeNav = NAVS.find((n) => isActive(n.to)) ?? NAVS[0];
  const pageTitle = t(activeNav.key);
  const pageSub =
    activeNav.key === "overview"
      ? th("overviewSub", { count: syncStatus.total })
      : th(`${activeNav.key}Sub` as "accountsSub" | "insightsSub" | "settingsSub");
  const initial = userName.trim().charAt(0).toUpperCase() || "?";

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

        {/* footer:纯身份展示(账户/外观入口迁 Settings) */}
        <div className="mt-auto flex items-center gap-2.5 px-1 pt-4">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-foreground text-xs">
            {initial}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate font-medium text-xs">{userName}</div>
            <div className="text-muted-foreground text-xs">{ts("selfHosted")}</div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动顶栏:只剩品牌 logo(控件全迁 Settings);sticky + 毛玻璃锚点。
            顶部内边距叠加 safe-area-inset-top:viewport-fit=cover + 半透状态栏下,内容不被刘海压
            (毛玻璃底延伸到状态栏下,成沉浸观感;bg/blur 不变、不碰 sticky)。 */}
        <header className="sticky top-0 z-30 flex items-center gap-2.5 border-border border-b bg-background/80 px-4 pt-[calc(0.75rem_+_env(safe-area-inset-top))] pb-3 backdrop-blur-xl lg:hidden">
          <Logo className="size-6 shrink-0" />
          <span className="font-semibold text-lg tracking-tight">folio</span>
        </header>

        {/* relative:作页面级 <HeaderSync/> 的定位上下文 —— 同步入口由各页自行绝对定位落到页头右上角。 */}
        <main className="relative mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-28 lg:px-8 lg:pb-10">
          {/* Portfolio 选择器 = 标题上方的小 badge(eyebrow);Settings 页不显示。 */}
          <PageHeader
            title={pageTitle}
            subtitle={pageSub}
            eyebrow={activeNav.key !== "settings" ? selector : null}
          />
          {children}
        </main>
      </div>

      {/* 移动底部悬浮 Dock 导航;底部偏移叠加 safe-area-inset-bottom,不被指示条压(定位/居中不变)。 */}
      <nav className="-translate-x-1/2 fixed bottom-[calc(1.25rem_+_env(safe-area-inset-bottom))] left-1/2 z-40 lg:hidden">
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
