import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL, STALE_TIME } from "@/lib/queries/constants";
import { type DataVersionOptions, watchDataVersion } from "@/lib/queries/data-version";
import { accountKeys, dataVersionKeys, portfolioKeys } from "@/lib/queries/keys";
import { lockQueryCache } from "@/lib/queries/persist";

// Data-version-driven refresh: focus/interval only asks for the version; a changed version invalidates
// data queries; the first version read with none cached is just recorded. Uses a real QueryClient since
// refetch behaviour is react-query's. `.tsx` because react-query disables refetchInterval without `window`.

const PF = "pf-1";
let queryClient: QueryClient;
let serverVersion: number;
let versionFetches: number;
const dataFetches = { accounts: 0, snapshots: 0 };
const unsubs: (() => void)[] = [];

const versionOptions = (): DataVersionOptions => ({
  queryKey: dataVersionKeys.all,
  queryFn: async () => {
    versionFetches++;
    return { version: serverVersion };
  },
  staleTime: 0,
  refetchInterval: POLL_INTERVAL.dataVersion,
});

// Two data queries with observers (as on a page), already cached and fresh.
function mountDataQueries() {
  for (const [name, queryKey] of [
    ["accounts", accountKeys.list(PF)],
    ["snapshots", portfolioKeys.snapshots(PF, 0)],
  ] as const) {
    queryClient.setQueryData([...queryKey], { seeded: true });
    const observer = new QueryObserver(queryClient, {
      queryKey: [...queryKey],
      queryFn: async () => {
        dataFetches[name]++;
        return { fetched: dataFetches[name] };
      },
      staleTime: STALE_TIME.live,
    });
    unsubs.push(observer.subscribe(() => {}));
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.mount(); // subscribes to focusManager (QueryClientProvider does this in the app)
  serverVersion = 1;
  versionFetches = 0;
  dataFetches.accounts = 0;
  dataFetches.snapshots = 0;
  focusManager.setFocused(true);
});

afterEach(() => {
  for (const u of unsubs.splice(0)) u();
  queryClient.clear();
  queryClient.unmount();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe("data-version-driven refresh", () => {
  it("on focus: asks only for the version; unchanged → no data query refetches", async () => {
    queryClient.setQueryData(dataVersionKeys.all, { version: 1 }); // version saved last time
    mountDataQueries();
    unsubs.push(watchDataVersion(queryClient, versionOptions()));
    await flush();
    expect(versionFetches).toBe(1); // the mount fetch

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush();

    expect(versionFetches).toBe(2);
    expect(dataFetches).toEqual({ accounts: 0, snapshots: 0 });
  });

  it("polls the version every minute while visible; data queries stay put", async () => {
    queryClient.setQueryData(dataVersionKeys.all, { version: 1 });
    mountDataQueries();
    unsubs.push(watchDataVersion(queryClient, versionOptions()));
    await flush();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL.dataVersion * 3);

    expect(versionFetches).toBe(4);
    expect(dataFetches).toEqual({ accounts: 0, snapshots: 0 });
  });

  it("version changed → data queries invalidated, mounted ones refetch at once", async () => {
    queryClient.setQueryData(dataVersionKeys.all, { version: 1 });
    mountDataQueries();
    unsubs.push(watchDataVersion(queryClient, versionOptions()));
    await flush();
    expect(dataFetches).toEqual({ accounts: 0, snapshots: 0 });

    serverVersion = 2; // written elsewhere (background sync / another device)
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush();

    expect(dataFetches).toEqual({ accounts: 1, snapshots: 1 });
    // The version query itself isn't invalidated, so it isn't asked again.
    expect(versionFetches).toBe(2);
  });

  it("stored version stale on reopen → the mount fetch invalidates data queries", async () => {
    queryClient.setQueryData(dataVersionKeys.all, { version: 1 });
    serverVersion = 5;
    mountDataQueries();
    unsubs.push(watchDataVersion(queryClient, versionOptions()));
    await flush();

    expect(dataFetches).toEqual({ accounts: 1, snapshots: 1 });
  });

  it("no cached version (first open) → first read is just recorded, no invalidation", async () => {
    mountDataQueries();
    unsubs.push(watchDataVersion(queryClient, versionOptions()));
    await flush();

    expect(versionFetches).toBe(1);
    expect(dataFetches).toEqual({ accounts: 0, snapshots: 0 });
  });

  it("lock drops the memory cache but keeps the version → a changed version after unlock invalidates", async () => {
    queryClient.setQueryData(dataVersionKeys.all, { version: 1 });
    mountDataQueries();
    const stopWatching = watchDataVersion(queryClient, versionOptions());
    await flush();

    // Lock: page (and watcher) unmount; unobserved queries are dropped — except the version.
    stopWatching();
    for (const u of unsubs.splice(0)) u();
    await lockQueryCache(queryClient);
    expect(queryClient.getQueryData(dataVersionKeys.all)).toEqual({ version: 1 });
    expect(queryClient.getQueryData([...accountKeys.list(PF)])).toBeUndefined();

    // Unlock: page remounts and refetches (version still 1), but the watcher's first read is already 2
    // (a background sync landed meanwhile) — must invalidate, not adopt 2 as the baseline.
    mountDataQueries();
    serverVersion = 2;
    unsubs.push(watchDataVersion(queryClient, versionOptions()));
    await flush();

    expect(dataFetches).toEqual({ accounts: 1, snapshots: 1 });
  });
});
