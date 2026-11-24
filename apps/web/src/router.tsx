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
        retry: shouldRetry,
        retryDelay: RETRY.delay,
        // Queries are persisted to IndexedDB, but only what's still in memory gets written: the
        // default 5-min gcTime would drop unmounted queries before they reach disk.
        gcTime: PERSIST_MAX_AGE_MS,
      },
    },
    // react-query only sets isError and swallows the real message (e.g. D1 "no such column").
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

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
