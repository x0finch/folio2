import { type QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import type { dataVersionKeys } from "./keys";
import { invalidateFor } from "./refresh";

// Instead of refetching everything on a timer (costly at 10ms CPU and 100k requests/day), poll one
// number that a DB trigger bumps on every user-visible write, and invalidate only when it changes.
//
// The first version seen without a cached one is recorded, not acted on, so it must not be newer
// than the data: the auth route fetches it before the loaders when uncached, and locking keeps it.
// Our own writes cause one extra refresh; telling them apart from a concurrent background sync is
// unreliable, and a missed refresh fails silently.

/** The caller supplies queryFn (a server fn) so this file stays importable in node tests. */
export type DataVersionOptions = QueryObserverOptions<{ version: number }> & {
  queryKey: typeof dataVersionKeys.all;
};

/**
 * Returns an unsubscribe function. A `QueryObserver` instead of `useQuery` + `useEffect`: the
 * comparison isn't render state, and it runs in tests without React.
 */
export function watchDataVersion(
  queryClient: QueryClient,
  options: DataVersionOptions,
): () => void {
  let seen = queryClient.getQueryData<{ version: number }>(options.queryKey)?.version;
  const observer = new QueryObserver(queryClient, options);
  return observer.subscribe((result) => {
    if (result.status !== "success" || result.isFetching) return;
    const next = result.data.version;
    if (seen === next) return;
    const had = seen !== undefined;
    seen = next;
    if (had) void invalidateFor(queryClient, "data.changed");
  });
}
