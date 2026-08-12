import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { APP_SCROLL_SELECTOR } from "./lib/app-scroll";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const queryClient = new QueryClient({
    // 全局兜底:任何 query 失败都把真实报错打到控制台(浏览器端 / SSR 服务端)。
    // 否则 react-query 只置 isError,真实消息(如 D1 "no such column")会被吞在 error 对象里,
    // 组件只显示泛化错误 UI,排查时看不到根因。
    queryCache: new QueryCache({
      onError: (error, query) => {
        console.error(`[query ${JSON.stringify(query.queryKey)}] failed:`, error);
      },
    }),
  });
  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // 手机上滚动在容器里(ADR 0042),而 router 对**内滚元素**的默认动作是把上一页的位置
    // 带到下一页 —— 于是短页面会开在被夹到底的位置、长页面会开在半中间。这个选项关掉那个
    // 「带过去」,改成每次导航把容器归零。它是**无条件**的(连该复原的前进/后退也清零),
    // 「切回来位置还在」那一半由 `useAppScrollMemory` 在它之后补 —— 两层的分工与实测依据
    // 写在那个 hook 的顶部。这里配的是安全的那一头:那层没跑起来也只是「总是回顶」。
    scrollToTopSelectors: [APP_SCROLL_SELECTOR],
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });

  // TanStack Start 官方 query 集成:注入 QueryClientProvider + SSR dehydrate/hydrate。
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
