import { Toaster, useMediaQuery } from "@folio/ui";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { ClientOnly, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useEffect, useState } from "react";
import { IntlProvider } from "use-intl";
import { AppShellSkeleton } from "@/components/app-shell";
import { applyStoredTheme, THEME_INIT_SCRIPT } from "@/lib/hooks/use-theme";
import { LOCALE_INIT_SCRIPT, useLocalePreference } from "@/lib/i18n/locale-preference";
import { messages } from "@/lib/i18n/messages";
import { registerServiceWorker, useUpdateToast } from "@/lib/pwa/service-worker";
import appCss from "@/styles.css?url";
import { appCssLoaderScript, SPLASH_STYLE, THEME_COLORS } from "./pwa-head";
import { SplashScreen } from "./splash";

// Top on mobile (the floating Dock owns the bottom), bottom-right on desktop; 64rem matches the
// shell's `lg:` breakpoint. 3.75rem = mobile top bar height (3.25rem + 1px) plus a gap; change it
// together with the top bar in app-shell.
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

// useUpdateToast needs IntlProvider, which RootDocument itself sits outside of.
function UpdateWatcher() {
  useUpdateToast();
  return null;
}

// Rendered once at build time and served statically to everyone, so nothing here may depend on who,
// when, or which language. Locale is fixed up by LOCALE_INIT_SCRIPT before React; `now` must come
// from the browser (a server value would be the release time).
export function RootDocument({ children }: { children: React.ReactNode }) {
  const locale = useLocalePreference();
  const [now] = useState(() => new Date());
  // Hydration recovery can wipe the `.dark` set by the head script, and nothing else restores it
  // (useTheme mounts only on settings).
  useEffect(() => {
    applyStoredTheme();
    return registerServiceWorker();
  }, []);
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Static JSX, not head(): TanStack dedupes meta by name. */}
        {THEME_COLORS.map((tc) => (
          <meta key={tc.media} name="theme-color" media={tc.media} content={tc.content} />
        ))}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static constant script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static constant script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: LOCALE_INIT_SCRIPT }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static constant style, no user input */}
        <style dangerouslySetInnerHTML={{ __html: SPLASH_STYLE }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static script; href is a build-time asset URL */}
        <script dangerouslySetInnerHTML={{ __html: appCssLoaderScript(appCss) }} />
        <noscript>
          <link rel="stylesheet" href={appCss} />
        </noscript>
      </head>
      <body>
        <IntlProvider
          locale={locale}
          messages={messages[locale]}
          timeZone="UTC"
          now={now}
          // Missing translation → the key itself, which for Inputs is the English source label.
          getMessageFallback={({ key }) => key}
        >
          {/* Hides children with visibility:hidden until release (still rendered and hydrated), so
              nothing can flash ahead of the splash. */}
          <SplashScreen>
            {/* The single static shell serves every URL, so this frame renders a route-agnostic
                skeleton; rendering the route here would bake `/` in and mismatch elsewhere. */}
            <ClientOnly fallback={<AppShellSkeleton />}>{children}</ClientOnly>
          </SplashScreen>
          <AppToaster />
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
