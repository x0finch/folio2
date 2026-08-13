import { cn, Dock, DockItem, SharedLayoutBg } from "@folio/ui";
import { Link, useRouterState } from "@tanstack/react-router";
import { BarChart3, Home, Settings, Wallet } from "lucide-react";
import { useMotionValue } from "motion/react";
import { type ReactNode, useRef } from "react";
import { useTranslations } from "use-intl";
import { APP_SCROLL_ID } from "../lib/app-scroll";
import { useAppScrollMemory } from "../lib/hooks/use-app-scroll-memory";
import { useBackgroundScale } from "../lib/hooks/use-background-scale";
import { useTapToTop } from "../lib/hooks/use-tap-to-top";
import { SheetProgressProvider } from "../lib/sheet-progress";
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
  // 每个 tab 记住自己滚到哪了(切走再回来停在原处、第一次进落顶部)。外壳拥有滚动容器,
  // 所以这件事挂在这里;为什么不能只靠 router 见 hook 顶部。
  useAppScrollMemory();
  const tapToTop = useTapToTop();
<<<<<<< HEAD
=======
  const reduce = useReducedMotion() ?? false;
  // 抽屉上滑时整屏往后收一层(片9)。进度由抽屉写、这里订阅 —— 抽屉 portal 到 body,
  // 两边在 React 树里离得远,共享一个 motion value 是唯一不牵动整棵树的传法。
  const shellRef = useRef<HTMLDivElement>(null);
  const sheetProgress = useMotionValue(0);
  useBackgroundScale(shellRef, sheetProgress);
>>>>>>> 58c8104 (feat(web): the background shrinks back as the sheet is pulled up)
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
<<<<<<< HEAD
    // 手机:外壳定高、内容在下面那个框里滚(ADR 0042)—— 顶栏因此是真正不动的一条,而不是靠 sticky
    // 跟着滚。桌面**故意**还滚整页(侧滑 Drawer 锁背景靠的是 body 的 overflow),所以 lg 上把高度与
    // overflow 全还回去。两种模型并存是有意的,不是没改完。
    //
    // 高度取 **`h-full`(百分比)**,不是 `100svh` 也不是 `fixed inset-0` —— 那两个真机上都错:
    // iOS 独立窗口(standalone + `viewport-fit=cover`)首帧报的视口偏短(实测 screen 852 而 inH 793),
    // 照那个数排就会在屏幕底部留一条填不满的空白、悬浮 Dock 贴在那条假底边上方,手指滑一下 iOS 才纠正。
    // 百分比顺着 `html/body/#app` 的百分比链走,那条链首帧就是整屏 —— main 不出这个毛病也是因为
    // 它的高度来自这条链。`styles.css` 里把那三层的 `height: 100%` 补齐了。
    <div className="flex h-full flex-col overflow-hidden lg:h-auto lg:min-h-svh lg:flex-row lg:overflow-visible">
      {/* 桌面常驻左侧栏 */}
      <aside className="hidden w-59 shrink-0 flex-col border-border border-r bg-card px-3.5 py-4.5 lg:sticky lg:top-0 lg:flex lg:h-svh lg:overflow-y-auto">
        <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-5">
          <Logo className="size-6 shrink-0" />
          <span className="font-semibold text-lg tracking-tight">folio</span>
        </div>
=======
    // Provider 包在外壳**外面**:抽屉 portal 到 body,但在 React 树里是这里的后代 → 它读得到
    // 这个进度值,而外壳自己订阅的是同一个值(直接传参,不经 context —— 它在 Provider 外面)。
    <SheetProgressProvider progress={sheetProgress}>
      {/* 手机:外壳固定一屏高、内容在下面那个框里滚(ADR 0042)—— 顶栏因此是真正不动的一条,
          而不是靠 sticky 跟着滚。桌面**故意**还滚整页(侧滑 Drawer 锁背景靠的是 body 的 overflow),
          所以 lg 上把高度与 overflow 全还回去。两种模型并存是有意的,不是没改完。
          ref:抽屉上滑时缩的就是这一层(片9)—— Dock 在它里面,所以跟着一起收,那是原生的样子。 */}
      <div
        ref={shellRef}
        className="flex h-svh flex-col overflow-hidden lg:h-auto lg:min-h-svh lg:flex-row lg:overflow-visible"
      >
        {/* 桌面常驻左侧栏 */}
        <aside className="hidden w-59 shrink-0 flex-col border-border border-r bg-card px-3.5 py-4.5 lg:sticky lg:top-0 lg:flex lg:h-svh lg:overflow-y-auto">
          <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-5">
            <Logo className="size-6 shrink-0" />
            <span className="font-semibold text-lg tracking-tight">folio</span>
          </div>
>>>>>>> 58c8104 (feat(web): the background shrinks back as the sheet is pulled up)

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

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 移动顶栏:只剩品牌 logo(控件全迁 Settings)。**在滚动区外面**,所以不再需要 sticky ——
            它就是不动的一条(ADR 0042)。顶部内边距叠加 safe-area-inset-top:viewport-fit=cover +
            半透状态栏下,内容不被刘海压(毛玻璃底延伸到状态栏下,成沉浸观感)。 */}
          <header className="z-30 flex items-center gap-2.5 border-border border-b bg-background/80 px-4 pt-[calc(0.75rem_+_env(safe-area-inset-top))] pb-3 backdrop-blur-xl lg:hidden">
            <Logo className="size-6 shrink-0" />
            <span className="font-semibold text-lg tracking-tight">folio</span>
          </header>

          {/* 手机端的滚动容器(ADR 0042)。三件事挂在这一个元素上:
            ① `data-scroll-restoration-id` —— router 按它存/取滚动位置(切页回来还在原处)。
               没这个属性它会退化成一条按 DOM 位置算出来的 CSS 路径选择器,渲染结构一变就失配。
               `useScrollLock` 也用同一个属性找容器,一个属性两用。
            ② `overscroll-contain` —— 容器内滚到头不把回弹传给整页(body 上的
               `overscroll-behavior: none` 照旧留着,它挡的是整页那一层)。
            ③ lg 上 overflow 还回 visible → 桌面滚整页,`useScrollLock` 在那儿自动成空操作。
            relative:作页面级 <HeaderSync/> 的定位上下文 —— 同步入口由各页自行绝对定位落到页头右上角。 */}
          <main
            data-scroll-restoration-id={APP_SCROLL_ID}
            className="relative mx-auto w-full max-w-5xl flex-1 overflow-y-auto overscroll-contain px-4 pt-6 pb-28 lg:overflow-visible lg:px-8 lg:pb-10"
          >
            {/* Portfolio 选择器 = 标题上方的小 badge(eyebrow);Settings 页不显示。 */}
            <PageHeader
              title={pageTitle}
              subtitle={pageSub}
              eyebrow={activeNav.key !== "settings" ? selector : null}
            />
            {children}
          </main>
        </div>

<<<<<<< HEAD
      {/* 移动底部悬浮 Dock 导航;底部偏移叠加 safe-area-inset-bottom,不被指示条压(定位/居中不变)。 */}
      <nav className="-translate-x-1/2 fixed bottom-[calc(1.25rem_+_env(safe-area-inset-bottom))] left-1/2 z-40 lg:hidden">
        <Dock>
          {NAVS.map(({ key, to, icon: Icon }) => (
            <DockItem key={key} active={isActive(to)}>
              <Link
                to={to}
                aria-label={t(key)}
                // 再点当前 tab → 滚回顶部、不导航(片4)。非当前 tab 照常切页。
                onClick={tapToTop(isActive(to))}
                className="flex size-full items-center justify-center"
              >
                <Icon className="size-5" />
              </Link>
            </DockItem>
          ))}
        </Dock>
      </nav>
    </div>
=======
        {/* 移动底部悬浮 Dock 导航;底部偏移叠加 safe-area-inset-bottom,不被指示条压(定位/居中不变)。 */}
        <nav className="-translate-x-1/2 fixed bottom-[calc(1.25rem_+_env(safe-area-inset-bottom))] left-1/2 z-40 lg:hidden">
          <Dock>
            {NAVS.map(({ key, to, icon: Icon }) => (
              <DockItem key={key} active={isActive(to)}>
                <Link
                  to={to}
                  aria-label={t(key)}
                  // 再点当前 tab → 滚回顶部、不导航(片4)。非当前 tab 照常切页。
                  onClick={tapToTop(isActive(to))}
                  className="flex size-full items-center justify-center"
                >
                  {/* 按下反馈(片3):触摸屏没有 hover,按下这一下是唯一的即时回应。
                    用 motion 的 whileTap 而不是 CSS `:active` —— iOS Safari 只在元素挂了触摸
                    监听时才给 `:active`,whileTap 走 pointer 事件,不用那个偏方。
                    缩的是图标这一层,不碰 <Link> 自己的命中区,也不碰 vendored Dock 的药丸。 */}
                  <motion.span
                    whileTap={reduce ? undefined : { scale: 0.86 }}
                    transition={SPRING_PRESS}
                    className="flex"
                  >
                    <Icon className="size-5" />
                  </motion.span>
                </Link>
              </DockItem>
            ))}
          </Dock>
        </nav>
      </div>
    </SheetProgressProvider>
>>>>>>> 58c8104 (feat(web): the background shrinks back as the sheet is pulled up)
  );
}
