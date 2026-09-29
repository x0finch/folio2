import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { RETRY, shouldRetry } from "./lib/queries/constants";
import { PERSIST_MAX_AGE_MS } from "./lib/queries/persist";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // 拉失败就退着重试,别一次就判死(判据与档位见 queries/constants)。
        retry: shouldRetry,
        retryDelay: RETRY.delay,
        // 查询缓存落 IndexedDB(FOL-94,`lib/queries/persist.ts`):存下来的只是内存里还在的那些,
        // 缺省 5 分钟的 gcTime 会让没挂着的查询先从内存里被回收、下一次写盘就一并消失 ——
        // 于是只有「最后五分钟看过的那页」能活过重开。与持久化的最长年纪取齐。
        // (这是 gcTime,不是 staleTime —— 后者仍按 ADR 0038 由各查询自己定。)
        gcTime: PERSIST_MAX_AGE_MS,
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
