import { cn, Dock, DockItem, SharedLayoutBg, Skeleton } from "@folio/ui";
import { Link, useRouterState } from "@tanstack/react-router";
import { BarChart3, Home, Settings, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import type { SyncStatusSummary } from "@/lib/server/sync/status";
import { Logo } from "./logo";
import { PageHeader } from "./page-header";

// iOS Safari 的 `:active` 需要元素挂着触摸监听才生效。提到模块级:身份稳定,不会每次渲染换一个。
const NOOP = () => {};

const NAVS = [
  { key: "overview", to: "/", icon: Home },
  { key: "accounts", to: "/accounts", icon: Wallet },
  { key: "insights", to: "/insights", icon: BarChart3 },
  { key: "settings", to: "/settings", icon: Settings },
] as const;

// 外壳的骨架(`AppShellSkeleton`)必须和真外壳**同一套盒子**,否则数据到位那一下整页会跳。
// 所以这几段布局类名抽成常量由两边共用 —— 改一处两边一起动,没有「忘了同步另一半」这回事。
// 只抽**盒子**,不抽内容:内容正是两边该不同的地方。
const SHELL_ROOT = "min-h-svh lg:flex";
const SHELL_ASIDE =
  "hidden w-59 shrink-0 flex-col border-border border-r bg-card px-3.5 py-4.5 lg:sticky lg:top-0 lg:flex lg:h-svh lg:overflow-y-auto";
const SHELL_BRAND_ROW = "flex items-center gap-2.5 px-2 pt-1.5 pb-5";
const SHELL_INNER_COL = "flex min-w-0 flex-1 flex-col";
const SHELL_SIDEBAR_FOOTER = "mt-auto flex items-center gap-2.5 px-1 pt-4";
const SHELL_TOPBAR =
  "sticky top-0 z-30 flex items-center gap-2.5 border-border border-b bg-background/80 px-4 pt-[calc(0.75rem_+_env(safe-area-inset-top))] pb-3 backdrop-blur-xl lg:hidden";
const SHELL_MAIN = "relative mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-28 lg:px-8 lg:pb-10";
const SHELL_DOCK_WRAP =
  "-translate-x-1/2 fixed bottom-[calc(1.25rem_+_env(safe-area-inset-bottom))] left-1/2 z-40 lg:hidden";

// 骨架里的占位槽:三个小指标 + 六行列表(六行刚好铺满手机首屏)。
const STAT_SLOTS = ["s1", "s2", "s3"];
const ROW_SLOTS = ["r1", "r2", "r3", "r4", "r5", "r6"];

// Span twin of the ui Skeleton (registry component is a fixed <div>): h1/p accept
// only phrasing content, and a div inside them makes the browser restructure the
// server HTML — hydration then fails (React #418, caught by the authed-shell e2e).
function SkeletonText({ className }: { className?: string }) {
  return (
    <span
      data-slot="skeleton"
      className={cn("inline-block animate-pulse rounded-md bg-muted align-middle", className)}
    />
  );
}

// 品牌行(logo + 字标):侧栏顶、移动顶栏、骨架壳三处同一份。
function Brand() {
  return (
    <>
      <Logo className="size-6 shrink-0" />
      <span className="font-semibold text-lg tracking-tight">folio</span>
    </>
  );
}

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
    <div className={SHELL_ROOT}>
      {/* 桌面常驻左侧栏 */}
      <aside className={SHELL_ASIDE}>
        <div className={SHELL_BRAND_ROW}>
          <Brand />
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
        <div className={SHELL_SIDEBAR_FOOTER}>
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-foreground text-xs">
            {initial}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate font-medium text-xs">{userName}</div>
            <div className="text-muted-foreground text-xs">{ts("selfHosted")}</div>
          </div>
        </div>
      </aside>

      <div className={SHELL_INNER_COL}>
        {/* 移动顶栏:只剩品牌 logo(控件全迁 Settings);sticky + 毛玻璃锚点。
            顶部内边距叠加 safe-area-inset-top:viewport-fit=cover + 半透状态栏下,内容不被刘海压
            (毛玻璃底延伸到状态栏下,成沉浸观感;bg/blur 不变、不碰 sticky)。 */}
        <header className={SHELL_TOPBAR}>
          <Brand />
        </header>

        {/* relative:作页面级 <HeaderSync/> 的定位上下文 —— 同步入口由各页自行绝对定位落到页头右上角。 */}
        <main className={SHELL_MAIN}>
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
      <nav className={SHELL_DOCK_WRAP}>
        <Dock>
          {NAVS.map(({ key, to, icon: Icon }) => (
            <DockItem key={key} active={isActive(to)}>
              <Link
                to={to}
                aria-label={t(key)}
                // iOS Safari 只在元素(或祖先)挂了触摸监听时才给 `:active` —— 这个空监听就是那把钥匙,
                // 是这条路子公认的代价。**别删**:删了 iOS 上按下就完全没反应(桌面照旧有)。
                onTouchStart={NOOP}
                className="group flex size-full items-center justify-center"
              >
                {/* 按下反馈(片3):触摸屏没有 hover,按下这一下是唯一的即时回应。
                    **走 CSS `:active`,不用 motion 的 `whileTap`** —— 后者在这个 App 里量不到任何效果:
                    按住时元素上既没有 transform 也没有内联样式,CDP 查那个元素连一个手势监听都没挂
                    (vendored Button 用的是同一种写法,同样量不到)。为什么不挂没继续深挖,那是另一条线;
                    这里要的是「一定看得见」,所以换成层叠这条确定的路。
                    缩 + 变淡都作用在这层 span 上:`<Link>` 是 44px 命中区,缩它等于按下瞬间把可点范围
                    也缩了;外面那个 `<DockItem>` 是 registry 装的,它自带的滑动药丸不能碰。
                    `motion-reduce:` 只去掉过渡,**保留状态变化** —— 减少动态效果不该等于「没有反馈」。 */}
                <span className="flex transition-[transform,opacity] duration-100 ease-out group-active:scale-[0.82] group-active:opacity-60 motion-reduce:transition-none">
                  <Icon className="size-5" />
                </span>
              </Link>
            </DockItem>
          ))}
        </Dock>
      </nav>
    </div>
  );
}

// 服务端唯一渲染的东西:一张零数据的骨架壳(ADR 0049 / FOL-34)。
//
// 登录后的路由整树 `ssr: false` 之后,服务器不再跑那 26 个查询、也不再渲染任何页面内容;
// 它出的就是这一张 —— 品牌 logo、导航轮廓、Dock 轮廓、内容灰条。数据由浏览器接手后渐进浮现。
//
// **零 props、零 hook、零查询**,这是它存在的全部意义:渲染它的 CPU 可以忽略不计,而
// 免费档一次请求只给 10 毫秒。所以这里不用 `useTranslations`(导航文字换成灰条)、
// 不用 `useRouterState`(没有 active 态)、更不碰 `syncStatus` / `userName` ——
// 后者会把用户身份渲进一份「等同静态资源」的 HTML 里,而这张壳未登录也可能拿得到。
//
// 盒子与 `AppShell` 共用同一组 SHELL_* 常量:数据到位那一下换的是内容,不是布局,所以不跳。
export function AppShellSkeleton() {
  return (
    <div className={SHELL_ROOT}>
      <aside className={SHELL_ASIDE}>
        <div className={SHELL_BRAND_ROW}>
          <Brand />
        </div>

        {/* 导航:图标是静态的(它们本来就不随数据变),文字位留灰条。
            Bar is h-5 = the 20px text-sm line box in the real nav rows, so each row
            lands at the same 36px total height (py-2 + 20px). */}
        <nav className="mt-4 flex flex-col gap-1">
          {NAVS.map(({ key, icon: Icon }) => (
            <div key={key} className="flex items-center gap-3 rounded-lg px-3 py-2">
              <Icon className="size-4 shrink-0 text-muted-foreground/40" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </nav>

        <div className={SHELL_SIDEBAR_FOOTER}>
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      </aside>

      <div className={SHELL_INNER_COL}>
        <header className={SHELL_TOPBAR}>
          <Brand />
        </header>

        <main className={SHELL_MAIN}>
          {/* Every box below is measured against the real Overview at 390px (the landing
              page): eyebrow row 25, title 38, subtitle 20, content starts at 198, hero
              240, tab row 32, list rows 72 each. Keep them in step — a box that drifts
              here is a jump the moment the browser takes over. */}
          <Skeleton className="absolute top-6 right-4 h-9 w-40 rounded-full lg:right-8" />
          {/* Render the REAL <PageHeader> (hook-free, provider-free — the shell's
              zero-provider constraint holds) with skeleton bars in its slots: the real
              h1/p supply the line boxes, so nothing is hand-transcribed to drift.
              inline-block matters: a block bar would collapse the h1's text line box. */}
          <PageHeader
            eyebrow={<SkeletonText className="h-6 w-20 rounded-full" />}
            title={<SkeletonText className="h-8 w-44" />}
            subtitle={<SkeletonText className="h-4 w-60" />}
          />
          <div className="flex flex-col gap-6">
            {/* 净值块:标题 + 大数字 + 三个小指标,高度锁 min-h-60 与真块一致。 */}
            <div className="min-h-60 pt-1">
              <Skeleton className="h-4 w-28" />
              <div className="mt-2 flex h-13 items-start gap-3">
                <Skeleton className="h-10 w-56" />
                <Skeleton className="h-9 w-24 rounded-full" />
              </div>
              <div className="mt-6 flex flex-wrap gap-8">
                {STAT_SLOTS.map((k) => (
                  <div key={k}>
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="mt-0.5 h-5 w-20" />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              {/* 分类标签行 + 右侧合计。 */}
              <div className="flex items-center gap-4">
                <Skeleton className="h-8 w-56 rounded-full" />
                <Skeleton className="ml-auto h-4 w-24" />
              </div>
              {/* 列表位:h-18 = 72,与真列表逐行对齐(高度含内边距,别写成内容高)。 */}
              <div className="flex w-full flex-col">
                {ROW_SLOTS.map((k) => (
                  <div key={k} className="flex h-18 items-center gap-3 px-3 py-3">
                    <Skeleton className="size-10 shrink-0 rounded-full" />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </main>
      </div>

      <nav className={SHELL_DOCK_WRAP}>
        <Dock>
          {NAVS.map(({ key, icon: Icon }) => (
            <DockItem key={key}>
              <span className="flex size-full items-center justify-center">
                <Icon className="size-5 text-muted-foreground/40" />
              </span>
            </DockItem>
          ))}
        </Dock>
      </nav>
    </div>
  );
}
