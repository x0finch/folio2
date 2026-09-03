import { Toaster, useMediaQuery } from "@folio/ui";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useEffect } from "react";
import { IntlProvider } from "use-intl";
import { applyStoredTheme, THEME_INIT_SCRIPT } from "@/lib/hooks/use-theme";
import { messages } from "@/lib/i18n/messages";
import { registerServiceWorker, useUpdateToast } from "@/lib/pwa/service-worker";
import { localePreferenceQuery } from "@/lib/queries/preferences";
import appCss from "@/styles.css?url";
// STARTUP_IMAGES 再次注释掉(排查入场抖动:隔离 iOS 启动图,确认抖动来自组件本身而非启动图切换)。
import { appCssLoaderScript, SPLASH_STYLE, THEME_COLORS } from "./pwa-head";
import { SplashScreen } from "./splash";

// 从 __root 的 loader 读 now(getRouteApi 免于反向 import Route 造成环)。
const rootRoute = getRouteApi("__root__");

// toast 的落位:手机顶部(叠安全区)、桌面右下角。
//
// **为什么不是「留在底部、抬到 Dock 之上」**:底部那一带被悬浮 Dock 占着,而同步一轮会连着堆
// 好几条 —— 抬高只是把同一个问题往上推几十像素。顶部本来就是原生横幅的位置。
//
// `classNames.root` 里那个 top 覆盖 vendored 位置类自带的 `top-4`(它排在位置类之后,twMerge 生效),
// 叠上 `env(safe-area-inset-top)` → 刘海/灵动岛下不压内容。
// 断点与外壳的手机形态(顶栏 / Dock 的 `lg:hidden`)对齐,那条线是 64rem。
//
// **3.75rem = 移动顶栏的高 + 一档间隙**:顶栏(见 app-shell)是 `pt-[0.75rem+safe] + 内容行 +
// pb-0.75rem + border-b 1px`,内容行由 `text-lg` 的 1.75rem 行高定(比 logo 的 1.5rem 高),
// 安全区之外合计 3.25rem + 1px;3.75rem 落点在顶栏下缘之下约 0.44rem。以前这里只叠了 0.75rem,
// 于是 toast 正落在顶栏那条毛玻璃上、压着 folio 的 logo(FOL-32 症状 5)。顶栏改高了这个数要
// 跟着改 —— 两处都在「移动外壳」这一件事里,没有第三处。
function AppToaster() {
  const isDesktop = useMediaQuery("(min-width: 64rem)");
  return isDesktop ? (
    <Toaster />
  ) : (
    <Toaster
      position="top-right"
      classNames={{ root: "top-[calc(env(safe-area-inset-top)+3.75rem)]" }}
    />
  );
}

// 运行中更新 toast 的挂载点:useUpdateToast 用 useTranslations,必须在 IntlProvider 之内(RootDocument
// 本身在 Provider 之外),故抽成一个渲染 null 的子组件。
function UpdateWatcher() {
  useUpdateToast();
  return null;
}

export function RootDocument({ children }: { children: React.ReactNode }) {
  const { now } = rootRoute.useLoaderData();
  const { data: locale } = useSuspenseQuery(localePreferenceQuery());
  // 挂载后重放主题:<head> 脚本负责首帧无闪,但 hydration recovery / 重渲染可能把它设的 .dark 冲掉
  // 且全站再无人恢复(useTheme 仅设置页挂载)→ 此处兜底,让 React 生命周期在每次(重)挂载后自愈。见 lib/hooks/use-theme。
  useEffect(() => {
    applyStoredTheme();
    // 生产注册 Service Worker(可安装外壳 + 离线兜底 + 更新流,ADR 0051);dev 内部直接 return。
    // 返回其清理函数,移除 controllerchange 监听。
    return registerServiceWorker();
  }, []);
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* theme-color 明暗两套:静态直渲(不进 head() 的 meta 数组,避开 TanStack 按 name 去重)。 */}
        {THEME_COLORS.map((tc) => (
          <meta key={tc.media} name="theme-color" media={tc.media} content={tc.content} />
        ))}
        {/* iOS 主屏启动图(ADR 0051):**再次注释掉排查入场抖动** —— 隔离启动图,确认 logo/文案的抖动
            来自 splash 组件本身,而非「iOS 启动图 → 网页」切换那下。确认后再决定恢复。
        {STARTUP_IMAGES.map((s) => (
          <link key={s.href} rel="apple-touch-startup-image" media={s.media} href={s.href} />
        ))} */}
        {/* 深色模式无闪烁:hydration 前就按 localStorage/system 设好 .dark(见 lib/hooks/use-theme)。 */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 静态常量脚本,无用户输入 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* 冷启动闪屏的关键样式(ADR 0051):内联,不依赖 app 样式表,首帧即可画覆盖层。 */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 静态常量样式,无用户输入 */}
        <style dangerouslySetInnerHTML={{ __html: SPLASH_STYLE }} />
        {/* app 样式表**非渲染阻塞**:脚本注入 link(不阻塞首帧),让内联的 splash 样式先画。 */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 静态常量脚本,href 来自构建期资产 URL */}
        <script dangerouslySetInnerHTML={{ __html: appCssLoaderScript(appCss) }} />
        {/* 无 JS 兜底:照常阻塞加载 app 样式表。 */}
        <noscript>
          <link rel="stylesheet" href={appCss} />
        </noscript>
      </head>
      <body>
        <IntlProvider
          locale={locale}
          messages={messages[locale]}
          timeZone="UTC"
          now={new Date(now)}
          // 缺翻译 → 回退到请求的 key 本身(对 Inputs 而言即英文源串 label;见 ProviderInput.label)。
          getMessageFallback={({ key }) => key}
        >
          {/* 冷启动闪屏(ADR 0051):**包住页面**。未放行前把 children 设 visibility:hidden(照常
              SSR/hydrate,只是不绘制)—— 没有可露脸的东西,从根上消除「页面抢在 splash 前闪一下」。
              就绪后覆盖层淡出、露出下面已渲好的页;阶段文案住 IntlProvider 内取。 */}
          <SplashScreen>{children}</SplashScreen>
          <AppToaster />
          {/* 运行中更新提示:探到新版弹「有新版本 · 更新」toast(住 IntlProvider 内取文案)。 */}
          <UpdateWatcher />
        </IntlProvider>
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
