import {
  type PersistedClient,
  type Persister,
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from "@tanstack/query-persist-client-core";
import type { Query, QueryClient } from "@tanstack/react-query";
import { clear, createStore, del, get, keys, set, type UseStore } from "idb-keyval";
import {
  accountKeys,
  connectorKeys,
  dataVersionKeys,
  portfolioKeys,
  preferenceKeys,
  settingsKeys,
  tagKeys,
  tokenKeys,
} from "./keys";

// **查询缓存落 IndexedDB**(FOL-94)。
//
// 免费档一天十万请求:冷开首页是十几发 server fn,而每次刷新 / 重开都从零再来一遍 —— 数据其实
// 只在有人写的时候变。存下来之后,重开页面先用上次的数据画,只问一个版本号(`data-version.ts`),
// 号没变就一发数据请求都不再打。
//
// 库:`@tanstack/query-persist-client-core`(官方的恢复 / 订阅 / buster / maxAge)+ `idb-keyval`
// (IndexedDB 的一层薄壳)。四道闸见 PR:① 只在浏览器跑,CF Workers 不涉及;② 两个都在维护
// (TanStack 同仓发版;idb-keyval 是 Chrome 团队 Jake Archibald 的,零依赖、~600B);③ 自己写
// hydrate/dehydrate 的版本与过期处理不值得;④ 版本钉在与 `@tanstack/react-query` 同一个 5.101.1,
// 于是只有一份 query-core。**没用** `@tanstack/query-async-storage-persister`:它只存字符串
// (`JSON.stringify`),而缓存里有 Map(富化字典等)—— IndexedDB 的结构化克隆原样存得下。
//
// **安全**:接口本来就不回凭据(`listAccounts` 只出 safeView:public 原样、semi 打码、secret 丢弃),
// 存下来的也只是那些。锁屏与登出把整个库清空(`clear` / `forget`),并停止写入。
//
// **按用户分键**:一条记录一个用户(`user:<id>`),开始持久化时顺手删掉别的用户的记录 ——
// 同一台机器换人登录,绝不会把上一个人的组合恢复出来。**按构建分代**:`buster` 取构建版本号,
// 发版之后旧形状的缓存整份作废,不会拿旧形状去喂新代码。

/** 存多久。超过这个年纪的记录恢复时直接丢(也是内存里 `gcTime` 的下限,见 router)。 */
export const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** 写盘节流:一次冷开会有几十个缓存事件,每个都整份写一遍 IndexedDB 不值得。 */
const PERSIST_THROTTLE_MS = 1_000;

/** 持久化存储的最小接口 —— 生产是 IndexedDB,单测给一个内存的。 */
export interface PersistStorage {
  get: (key: string) => Promise<PersistedClient | undefined>;
  set: (key: string, value: PersistedClient) => Promise<void>;
  del: (key: string) => Promise<void>;
  keys: () => Promise<string[]>;
  clear: () => Promise<void>;
}

// **存哪些**:按域前缀白名单。同步轮(`sync`)不存 —— 那是一轮同步的实时进度,存下来只会在
// 重开时先画一格过期的进度条;上游搜索结果也不存,换个词就是另一份。白名单而不是黑名单:
// 将来新加一个域,默认不落盘,要落得有人在这里写一行。
const PERSISTED_PREFIXES: readonly (readonly string[])[] = [
  portfolioKeys.all,
  accountKeys.all,
  tagKeys.all,
  settingsKeys.all,
  preferenceKeys.all,
  connectorKeys.all,
  dataVersionKeys.all,
  tokenKeys.catalogue(),
  tokenKeys.fiatOptions("").slice(0, 2),
  tokenKeys.enrichment(),
];

const startsWith = (key: readonly unknown[], prefix: readonly string[]) =>
  prefix.every((part, i) => key[i] === part);

export const isPersistedKey = (key: readonly unknown[]): boolean =>
  PERSISTED_PREFIXES.some((prefix) => startsWith(key, prefix));

const shouldDehydrateQuery = (query: Query) =>
  query.state.status === "success" && isPersistedKey(query.queryKey);

const recordKey = (userId: string) => `user:${userId}`;

export interface QueryPersistence {
  /**
   * 为这个用户开始持久化:删掉别人的记录 →(`restore` 时)把他上次的缓存恢复进内存 → 之后的
   * 缓存变化节流写盘。同一个用户重复调是 no-op(路由每次导航都会走到调用点)。
   */
  start: (queryClient: QueryClient, userId: string, opts?: { restore?: boolean }) => Promise<void>;
  /** 锁屏:停写 + 清盘。用户仍是这个人,`resume` 时接着写。 */
  clear: () => Promise<void>;
  /** 解锁:为同一个用户接着写(不恢复 —— 盘上已经清空了)。 */
  resume: (queryClient: QueryClient) => void;
  /** 登出 / 会话没了:停写 + 清盘 + 忘掉是谁,之后的 `resume` 什么都不做。 */
  forget: () => Promise<void>;
}

export function createQueryPersistence({
  storage,
  buster,
  throttleMs = PERSIST_THROTTLE_MS,
}: {
  storage: PersistStorage;
  buster: string;
  throttleMs?: number;
}): QueryPersistence {
  let userId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  // 每次停写 +1。节流里挂着的那次写盘醒来时先对一下代:停写之后(锁屏 / 登出)绝不能再落一份。
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let starting: { id: string; done: Promise<void> } | null = null;

  const persisterFor = (key: string): Persister => {
    let latest: PersistedClient | null = null;
    return {
      persistClient: (client) => {
        latest = client;
        if (timer) return;
        const gen = generation;
        timer = setTimeout(() => {
          timer = null;
          if (gen !== generation || !latest) return;
          // 写不进去(配额满、结构化克隆不了某个值)就算了:持久化是锦上添花,不该打断页面。
          storage.set(key, latest).catch(() => {});
        }, throttleMs);
      },
      restoreClient: () => storage.get(key),
      removeClient: () => storage.del(key),
    };
  };

  const stop = () => {
    generation++;
    if (timer) clearTimeout(timer);
    timer = null;
    unsubscribe?.();
    unsubscribe = null;
  };

  const subscribe = (queryClient: QueryClient, id: string) => {
    unsubscribe = persistQueryClientSubscribe({
      queryClient,
      persister: persisterFor(recordKey(id)),
      buster,
      dehydrateOptions: { shouldDehydrateQuery },
    });
  };

  const begin = async (
    queryClient: QueryClient,
    id: string,
    { restore = true }: { restore?: boolean } = {},
  ) => {
    stop();
    userId = id;
    const gen = generation;
    const mine = recordKey(id);
    try {
      const others = (await storage.keys()).filter((k) => k !== mine);
      await Promise.all(others.map((k) => storage.del(k)));
      if (restore) {
        await persistQueryClientRestore({
          queryClient,
          persister: persisterFor(mine),
          maxAge: PERSIST_MAX_AGE_MS,
          buster,
        });
      } else {
        await storage.del(mine);
      }
    } catch {
      // IndexedDB 打不开(隐私模式、被禁用):不恢复,照常联网取。
    }
    // 等待期间可能已经被锁屏 / 登出叫停了(它们都会 stop,代数就变了)—— 那就别再开始写。
    if (gen === generation) subscribe(queryClient, id);
  };

  return {
    start: (queryClient, id, opts) => {
      if (userId === id && unsubscribe) return Promise.resolve();
      // 同一个用户的上一次还在恢复(导航在它 resolve 之前又走了一遍鉴权):等那一次,别重来。
      if (starting?.id === id) return starting.done;
      const done = begin(queryClient, id, opts).finally(() => {
        if (starting?.done === done) starting = null;
      });
      starting = { id, done };
      return done;
    },
    clear: async () => {
      stop();
      await storage.clear().catch(() => {});
    },
    resume: (queryClient) => {
      if (userId && !unsubscribe) subscribe(queryClient, userId);
    },
    forget: async () => {
      stop();
      userId = null;
      await storage.clear().catch(() => {});
    },
  };
}

// —— 浏览器里的那一份 ——

const IDB_NAME = "folio-query-cache";
const IDB_STORE = "clients";

/**
 * IndexedDB 上的 `PersistStorage`。库**用到时才开**:`createStore` 一调用就 `indexedDB.open`,
 * 而这个模块也会被静态壳的构建(服务端)与 node 单测 import。
 */
function idbStorage(): PersistStorage {
  let store: UseStore | undefined;
  const db = () => {
    store ??= createStore(IDB_NAME, IDB_STORE);
    return store;
  };
  // 全部写成 async:没有 IndexedDB 的环境里 `createStore` 是**同步**抛的,包成 reject 才走得到
  // 调用方的 `.catch`。
  return {
    get: async (key) => get<PersistedClient>(key, db()),
    set: async (key, value) => set(key, value, db()),
    del: async (key) => del(key, db()),
    keys: async () => keys<string>(db()),
    clear: async () => clear(db()),
  };
}

let browserPersistence: QueryPersistence | undefined;

/** 这个标签页的那一份(惰性建)。`__APP_VERSION__` 是 vite `define` 注入的构建期常量,单测里没有。 */
export function queryPersistence(): QueryPersistence {
  const buster = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unversioned";
  browserPersistence ??= createQueryPersistence({ storage: idbStorage(), buster });
  return browserPersistence;
}

/**
 * **锁屏**:停写、清盘,并把内存里此刻没人挂着的查询一并扔掉(锁屏时整棵页面已卸载,剩下挂着的
 * 只有外壳那几条 —— 组合清单、展示币种、设置)。解锁后页面重挂,数据重新拉。
 */
export async function lockQueryCache(queryClient: QueryClient): Promise<void> {
  queryClient.removeQueries({ predicate: (q) => !q.isActive() });
  await queryPersistence().clear();
}

/** **登出 / 会话没了**:清盘 + 忘掉是谁 + 清空内存。 */
export async function forgetQueryCache(queryClient: QueryClient): Promise<void> {
  await queryPersistence().forget();
  queryClient.clear();
}
