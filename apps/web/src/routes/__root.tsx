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
      // app 样式表**不在这里**(否则渲染阻塞):改由 RootDocument 脚本注入 + <noscript> 兜底,
      // 让内联的冷启动闪屏样式先画、不白屏(ADR 0051)。
      { rel: "icon", type: "image/svg+xml", href: "/icon.svg" },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
      ...PWA_LINKS,
    ],
  }),
  // **没有 `beforeLoad` / `loader`,也不许加**(ADR 0049 补记):HTML 文档是构建期 prerender 出来的
  // 静态文件,根路由在服务端算的任何东西都会被烤进那一份、发给所有人 —— 以前的 307 守卫(读 cookie)、
  // `now`(发版那一刻)、locale(构建机的语言)实测都被烤进去过。请求相关的输入一律在浏览器里取:
  // 鉴权在 `_authed.beforeLoad`,`now` 与 locale 在 RootDocument。
  shellComponent: RootDocument,
});
