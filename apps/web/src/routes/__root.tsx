import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { IntlProvider } from "use-intl";

import { messages } from "../lib/i18n/messages";
import { getLocale } from "../lib/server/locale";
import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Folio",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  // SSR 首屏即正确语言:根 loader 定 locale(cookie/Accept-Language);切换时 invalidate 重跑。
  // now 也在此定(服务端时刻,序列化给客户端):作为 IntlProvider 的全局 now,relativeTime 才有基准
  //(否则 use-intl 抛 ENVIRONMENT_FALLBACK),且 SSR/客户端一致不产生 hydration 抖动。
  loader: async () => ({ locale: await getLocale(), now: Date.now() }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  const { locale, now } = Route.useLoaderData();
  return (
    <html lang={locale}>
      <head>
        <HeadContent />
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
