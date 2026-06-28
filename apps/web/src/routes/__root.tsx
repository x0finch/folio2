import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { IntlProvider } from "use-intl";

import { messages } from "../lib/i18n/messages";
import { getLocale } from "../lib/server/locale";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
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
  loader: () => getLocale(),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  const locale = Route.useLoaderData();
  return (
    <html lang={locale}>
      <head>
        <HeadContent />
      </head>
      <body>
        <IntlProvider locale={locale} messages={messages[locale]} timeZone="UTC">
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
