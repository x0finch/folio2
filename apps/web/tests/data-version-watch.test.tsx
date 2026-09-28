import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL, STALE_TIME } from "@/lib/queries/constants";
import { type DataVersionOptions, watchDataVersion } from "@/lib/queries/data-version";
import { accountKeys, dataVersionKeys, portfolioKeys } from "@/lib/queries/keys";

// 数据版本号驱动的刷新(FOL-94)。钉三件事:
//   ① 回到页面 / 定时 → **只问版本号**,挂着的数据查询一发都不重拉(它们的 staleTime 还没到);
//   ② 号变了 → 数据查询被失效、挂着的当场重拉;
//   ③ 缓存里本来没有号(头一回打开)→ 第一次读到只记下,不失效。
// 真 QueryClient + QueryObserver(不是 mock):刷不刷、刷谁是 react-query 的行为,mock 掉就等于
// 把要验的东西自己实现了一遍。
//
// **是 `.tsx` 不是因为渲染了什么**:react-query 在没有 `window` 的环境里当自己在服务端,
// 定时轮询(`refetchInterval`)直接关掉 —— 要验的正是它,所以得跑在 jsdom 那一档。

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

// 挂两条数据查询(像页面那样有观察者),数据已在缓存里且新鲜。
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
  queryClient.mount(); // 订阅 focusManager —— 页面里是 QueryClientProvider 做的
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

describe("数据版本号驱动的刷新", () => {
  it("回到页面:只问版本号,号没变就一条数据查询都不重拉", async () => {
    queryClient.setQueryData(dataVersionKeys.all, { version: 1 }); // 上次存下的号
    mountDataQueries();
    unsubs.push(watchDataVersion(queryClient, versionOptions()));
    await flush();
    expect(versionFetches).toBe(1); // 挂载那一发

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush();

    expect(versionFetches).toBe(2);
    expect(dataFetches).toEqual({ accounts: 0, snapshots: 0 });
  });

  it("可见时每分钟问一次版本号,数据查询不跟着动", async () => {
    queryClient.setQueryData(dataVersionKeys.all, { version: 1 });
    mountDataQueries();
    unsubs.push(watchDataVersion(queryClient, versionOptions()));
    await flush();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL.dataVersion * 3);

    expect(versionFetches).toBe(4);
    expect(dataFetches).toEqual({ accounts: 0, snapshots: 0 });
  });

  it("号变了 → 数据查询失效,挂着的当场重拉", async () => {
    queryClient.setQueryData(dataVersionKeys.all, { version: 1 });
    mountDataQueries();
    unsubs.push(watchDataVersion(queryClient, versionOptions()));
    await flush();
    expect(dataFetches).toEqual({ accounts: 0, snapshots: 0 });

    serverVersion = 2; // 别处(后台同步 / 另一台设备)写过了
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush();

    expect(dataFetches).toEqual({ accounts: 1, snapshots: 1 });
    // 版本号自己不在被失效的那批里 —— 不会因为失效再问一遍。
    expect(versionFetches).toBe(2);
  });

  it("重开页面时存下的号已经旧了 → 挂载那一发就失效数据查询", async () => {
    queryClient.setQueryData(dataVersionKeys.all, { version: 1 });
    serverVersion = 5;
    mountDataQueries();
    unsubs.push(watchDataVersion(queryClient, versionOptions()));
    await flush();

    expect(dataFetches).toEqual({ accounts: 1, snapshots: 1 });
  });

  it("缓存里没有号(头一回打开)→ 第一次读到只记下,不失效", async () => {
    mountDataQueries();
    unsubs.push(watchDataVersion(queryClient, versionOptions()));
    await flush();

    expect(versionFetches).toBe(1);
    expect(dataFetches).toEqual({ accounts: 0, snapshots: 0 });
  });
});
