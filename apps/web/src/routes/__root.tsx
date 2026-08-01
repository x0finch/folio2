import { Toaster } from "@folio/ui";
import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useEffect } from "react";
import { IntlProvider } from "use-intl";

import { messages } from "../lib/i18n/messages";
import { PWA_LINKS, PWA_META, THEME_COLORS, VIEWPORT } from "../lib/pwa-head";
import { registerServiceWorker } from "../lib/register-sw";
import { getLocalePreference } from "../lib/server/preferences";
import { applyStoredTheme, THEME_INIT_SCRIPT } from "../lib/theme";
import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: VIEWPORT,
      },
      {
        title: "Folio",
      },
      ...PWA_META,
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", type: "image/svg+xml", href: "/icon.svg" },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
      ...PWA_LINKS,
    ],
  }),
  // SSR 首屏即正确语言:根 loader 定 locale(cookie/Accept-Language);切换时 invalidate 重跑。
  // now 也在此定(服务端时刻,序列化给客户端):作为 IntlProvider 的全局 now,relativeTime 才有基准
  //(否则 use-intl 抛 ENVIRONMENT_FALLBACK),且 SSR/客户端一致不产生 hydration 抖动。
  loader: async () => ({ locale: await getLocalePreference(), now: Date.now() }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  const { locale, now } = Route.useLoaderData();
  // 挂载后重放主题:<head> 脚本负责首帧无闪,但 hydration recovery / 重渲染可能把它设的 .dark 冲掉
  // 且全站再无人恢复(useTheme 仅设置页挂载)→ 此处兜底,让 React 生命周期在每次(重)挂载后自愈。见 lib/theme。
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
        {/* 深色模式无闪烁:hydration 前就按 localStorage/system 设好 .dark(见 lib/theme)。 */}
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
          <Toaster />
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
