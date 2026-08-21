import { Toaster, useMediaQuery } from "@folio/ui";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useEffect } from "react";
import { IntlProvider } from "use-intl";
import { applyStoredTheme, THEME_INIT_SCRIPT } from "@/lib/hooks/use-theme";
import { messages } from "@/lib/i18n/messages";
import { localePreferenceQuery } from "@/lib/queries/preferences";
import { THEME_COLORS } from "./pwa-head";

// 从 __root 的 loader 读 now(getRouteApi 免于反向 import Route 造成环)。
const rootRoute = getRouteApi("__root__");

// 生产环境注册 Service Worker(ADR 0027)。dev 不注册 —— 免本地被 SW 缓存坑;
// 在 app 挂载后调用(非模块加载期)。失败静默降级:SW 只是增强(离线外壳 + Android 可安装),
// 不支持 module worker 的旧浏览器仍作已装 App 用,不影响主功能。
function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  // updateViaCache:none —— 更新检查不吃 HTTP 缓存,发新版即拿到新 sw.js。
  navigator.serviceWorker
    .register("/sw.js", { type: "module", updateViaCache: "none" })
    .catch(() => {
      // 静默:注册失败不该冒泡到 UI。
    });
}

// toast 的落位:手机顶部(叠安全区)、桌面右下角。
//
// **为什么不是「留在底部、抬到 Dock 之上」**:底部那一带被悬浮 Dock 占着,而同步一轮会连着堆
// 好几条 —— 抬高只是把同一个问题往上推几十像素。顶部本来就是原生横幅的位置。
//
// `classNames.root` 里那个 top 覆盖 vendored 位置类自带的 `top-4`(它排在位置类之后,twMerge 生效),
// 叠上 `env(safe-area-inset-top)` → 刘海/灵动岛下不压内容。
// 断点与外壳的手机形态(顶栏 / Dock 的 `lg:hidden`)对齐,那条线是 64rem。
function AppToaster() {
  const isDesktop = useMediaQuery("(min-width: 64rem)");
  return isDesktop ? (
    <Toaster />
  ) : (
    <Toaster
      position="top-right"
      classNames={{ root: "top-[calc(env(safe-area-inset-top)+0.75rem)]" }}
    />
  );
}

export function RootDocument({ children }: { children: React.ReactNode }) {
  const { now } = rootRoute.useLoaderData();
  const { data: locale } = useSuspenseQuery(localePreferenceQuery());
  // 挂载后重放主题:<head> 脚本负责首帧无闪,但 hydration recovery / 重渲染可能把它设的 .dark 冲掉
  // 且全站再无人恢复(useTheme 仅设置页挂载)→ 此处兜底,让 React 生命周期在每次(重)挂载后自愈。见 lib/hooks/use-theme。
  useEffect(() => {
    applyStoredTheme();
    // 生产注册 Service Worker(可安装外壳 + 离线兜底);dev 内部直接 return。
    registerServiceWorker();
  }, []);
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* theme-color 明暗两套:静态直渲(不进 head() 的 meta 数组,避开 TanStack 按 name 去重)。 */}
        {THEME_COLORS.map((tc) => (
          <meta key={tc.media} name="theme-color" media={tc.media} content={tc.content} />
        ))}
        {/* 深色模式无闪烁:hydration 前就按 localStorage/system 设好 .dark(见 lib/hooks/use-theme)。 */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 静态常量脚本,无用户输入 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
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
          {children}
          <AppToaster />
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
