import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, redirect } from "@tanstack/react-router";
import { localePreferenceQuery } from "@/lib/queries/preferences";
import { needsLoginRedirect } from "./-root/authed-guard";
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
      // app 样式表**不在这里**(否则渲染阻塞):改由 RootDocument 脚本注入 + <noscript> 兜底,
      // 让内联的冷启动闪屏样式先画、不白屏(ADR 0051)。
      { rel: "icon", type: "image/svg+xml", href: "/icon.svg" },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
      ...PWA_LINKS,
    ],
  }),
  // 未登录访问登录后页面 → 服务端 307 /login(ADR 0049)。判据只有「session cookie 在不在」,
  // 微秒级;真鉴权仍在 `_authed.beforeLoad`,只是那一层已经只在浏览器里跑了。理由与安全面见
  // ./-root/authed-guard。
  //
  // 放在 `beforeLoad` 而不是 `loader`:它先于 loader 跑,未登录那条路上连 locale 预取都省了。
  beforeLoad: ({ matches }) => {
    if (needsLoginRedirect(matches)) throw redirect({ to: "/login" });
  },
  // SSR 首屏即正确语言:loader **预取** locale(cookie/Accept-Language),组件从缓存读,
  // 切换时定向刷新那一条 key(ADR 0038)。
  // now 仍由 loader 直接返回(服务端时刻,序列化给客户端):它不是一次「读」,没有可刷新的语义 ——
  // 作为 IntlProvider 的全局 now,relativeTime 才有基准(否则 use-intl 抛 ENVIRONMENT_FALLBACK),
  // 且 SSR/客户端一致不产生 hydration 抖动。
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(localePreferenceQuery());
    return { now: Date.now() };
  },
  shellComponent: RootDocument,
});
