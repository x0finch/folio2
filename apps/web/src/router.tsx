import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
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
