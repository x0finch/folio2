import { QueryCache, QueryClient } from "@tanstack/react-query";
import {
  createRouter as createTanStackRouter,
  isNotFound,
  isRedirect,
} from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { RETRY } from "./lib/queries/constants";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // 拉失败就退着重试,别一次就判死(理由与档位见 queries/constants 的 RETRY)。
        // 判据只能看「是不是控制流」:server fn 的失败到了这里是一个没有状态码的通用 Error
        // (框架抛的 `Invariant failed`),分不出 500 还是 400 —— 所以反过来排除那两种
        // **重试没有意义**的:跳转(如会话过期要去登录页)与 404,其余一律再试。
        retry: (failureCount, error) =>
          !isRedirect(error) && !isNotFound(error) && failureCount < RETRY.attempts,
        retryDelay: RETRY.delay,
      },
    },
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
