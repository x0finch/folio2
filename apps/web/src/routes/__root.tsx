import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";
import { PWA_LINKS, PWA_META, VIEWPORT } from "./-root/pwa-head";
import { RootDocument } from "./-root/root-document";

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
      // The app stylesheet is injected by RootDocument instead, so it doesn't block the inline
      // cold-start splash.
      { rel: "icon", type: "image/svg+xml", href: "/icon.svg" },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
      ...PWA_LINKS,
    ],
  }),
  // No beforeLoad/loader here: the HTML document is prerendered at build time, so anything the
  // root computes on the server is baked in for everyone. Request-specific inputs belong in the
  // browser.
  shellComponent: RootDocument,
});
