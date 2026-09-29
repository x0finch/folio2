import {
  type PersistedClient,
  type Persister,
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from "@tanstack/query-persist-client-core";
import type { Query, QueryClient } from "@tanstack/react-query";
import {
  clear,
  createStore,
  del,
  get,
  keys,
  promisifyRequest,
  set,
  type UseStore,
} from "idb-keyval";
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
import { REFRESH_MAP } from "./refresh";

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
// 存下来的也只是那些。锁屏与登出把整个库清空(`clear` / `forget`),并停止写入 —— 登出还广播给
// 同一浏览器里的其它标签页,写盘前再对一遍户主,别的标签页登出之后谁也写不回来(review #3)。
//
// **按用户分键**:一条记录一个用户(`user:<id>`),开始持久化时顺手删掉别的用户的记录 ——
// 同一台机器换人登录,绝不会把上一个人的组合恢复出来。**按构建分代**:`buster` 取构建版本号,
// 发版之后旧形状的缓存整份作废,不会拿旧形状去喂新代码。

/** 存多久。超过这个年纪的记录恢复时直接丢(也是内存里 `gcTime` 的下限,见 router)。 */
export const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** 写盘节流:一次冷开会有几十个缓存事件,每个都整份写一遍 IndexedDB 不值得。 */
const PERSIST_THROTTLE_MS = 1_000;

/**
 * 持久化存储的最小接口 —— 生产是 IndexedDB,单测给一个内存的。
 *
 * **写盘带「户主」检查**(review #3):库里另存一个户主标记(`claim` 写、`clear` 连同记录一起抹掉),
 * `put` 只在户主**仍是**这个用户时才落 —— 读标记与写记录在**同一个事务**里,所以别的标签页
 * 登出(`clear`)之后,本页哪怕还没收到广播、节流里还挂着一次写,也落不下去:事务按开启顺序
 * 串行,排在 `clear` 后面的那次 `put` 读到的户主已经没了。
 */
export interface PersistStorage {
  get: (key: string) => Promise<PersistedClient | undefined>;
  /** 户主仍是 `owner` 才写(与读户主同一个事务);否则什么都不做。 */
  put: (key: string, value: PersistedClient, owner: string) => Promise<void>;
  /** 把户主记成 `owner`。 */
  claim: (owner: string) => Promise<void>;
  del: (key: string) => Promise<void>;
  keys: () => Promise<string[]>;
  /** 清空整个库 —— 记录与户主标记一起。 */
  clear: () => Promise<void>;
}

/**
 * 跨标签页的「登出了」广播(review #3)。生产是 `BroadcastChannel`,单测给一个假的。
 * 与锁屏标志跨标签同步(`use-idle-lock.ts` 的 storage 事件)同一个道理:会话是整个浏览器共用的
 * cookie,一个标签页登出,别的标签页手里那份缓存也不该再写回盘上。
 */
export interface SignOutChannel {
  /** 告诉别的标签页:这个会话没了(不会回送给自己)。 */
  announce: () => void;
  /** 别的标签页宣布登出时调 `fn`。 */
  listen: (fn: () => void) => void;
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

// **恢复出来算新鲜的**(review #13):版本号管得住的那批 —— 也就是号变了会被失效的那些
// (`REFRESH_MAP["data.changed"]`)。恢复时把它们的时间戳记成「现在」:号没变,它们就是对的,
// 不该因为上次拉取已过 15 分钟,重开页面时就把挂着的查询整批重拉一遍;号变了,版本号那一路
// (`data-version.ts`)照旧整批失效。
//
// **例外是带现价的**:富化字典里的现价由参考层按 TTL 刷,刷价**不抬版本号** —— 版本号担保不了它,
// 所以它保留原来的时间戳,过了 `STALE_TIME.live` 照常重拉(展示币种的汇率不在这批里,同理按它
// 自己的 staleTime 走)。
const VOUCHED_BY_VERSION = REFRESH_MAP["data.changed"];
const PRICE_BEARING: readonly (readonly string[])[] = [tokenKeys.enrichment()];

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((part, i) => key[i] === part);

export const isPersistedKey = (key: readonly unknown[]): boolean =>
  PERSISTED_PREFIXES.some((prefix) => startsWith(key, prefix));

const vouchedByVersion = (key: readonly unknown[]): boolean =>
  VOUCHED_BY_VERSION.some((prefix) => startsWith(key, prefix)) &&
  !PRICE_BEARING.some((prefix) => startsWith(key, prefix));

const shouldDehydrateQuery = (query: Query) =>
  query.state.status === "success" && isPersistedKey(query.queryKey);

/**
 * 刚恢复出来、版本号担保得了的查询:时间戳记成现在(见 `VOUCHED_BY_VERSION`)。
 *
 * **已经被标过失效的跳过**(review R2-#1):失效只重拉挂着的查询,没挂着的(别的页面、别的区间)
 * 只打个 `isInvalidated` 标记,就这么连同**新**版本号一起落了盘。`setQueryData` 会把这个标记清掉,
 * 而版本号又对得上、不会再失效一次 —— 那份已知过期的数据就会被当成新鲜的挂上 15 分钟。
 */
function freshenRestored(queryClient: QueryClient) {
  const now = Date.now();
  for (const query of queryClient.getQueryCache().getAll()) {
    if (query.state.status !== "success" || query.state.isInvalidated) continue;
    if (!vouchedByVersion(query.queryKey)) continue;
    queryClient.setQueryData(query.queryKey, query.state.data, { updatedAt: now });
  }
}

const RECORD_PREFIX = "user:";
const recordKey = (userId: string) => `${RECORD_PREFIX}${userId}`;

export interface QueryPersistence {
  /**
   * 为这个用户开始持久化:记下户主、删掉别人的记录 →(没锁时)把他上次的缓存恢复进内存 → 之后的
   * 缓存变化节流写盘。同一个用户重复调是 no-op(路由每次导航都会走到调用点)。
   *
   * `locked`:这台机器此刻锁着 —— 不恢复、把盘上那份删掉、**也不开始写**,等解锁时的 `resume`。
   * 锁屏期间的导航(浏览器后退、换组合参数)也会走到这里,它不能把写盘重新打开(review #14)。
   */
  start: (queryClient: QueryClient, userId: string, opts?: { locked?: boolean }) => Promise<void>;
  /** 锁屏:停写 + 清盘。用户仍是这个人,`resume` 时接着写;在那之前 `start` 也不会重新开写。 */
  clear: () => Promise<void>;
  /** 解锁:为同一个用户接着写(不恢复 —— 盘上已经清空了)。 */
  resume: (queryClient: QueryClient) => void;
  /**
   * 登出 / 会话没了:停写 + 清盘 + 忘掉是谁,之后的 `resume` 什么都不做;并**广播给别的标签页**,
   * 它们各自停写、清空内存里的数据(review #3)。
   */
  forget: () => Promise<void>;
  /** 别的标签页登出了、本页已经停写并清空内存之后调 `fn`(路由拿它把本页送回登录页)。返回退订。 */
  onSignedOutElsewhere: (fn: () => void) => () => void;
}

export function createQueryPersistence({
  storage,
  buster,
  channel,
  throttleMs = PERSIST_THROTTLE_MS,
}: {
  storage: PersistStorage;
  buster: string;
  /** 跨标签页登出广播;没有(单测、不支持 BroadcastChannel 的环境)时只靠户主检查兜着。 */
  channel?: SignOutChannel;
  throttleMs?: number;
}): QueryPersistence {
  let userId: string | null = null;
  let client: QueryClient | null = null;
  let unsubscribe: (() => void) | null = null;
  // 锁着:`clear` 置上、`resume` 撤掉。锁着的时候谁调 `start` 都不开写(review #14)。
  let paused = false;
  // 每次停写 +1。节流里挂着的那次写盘醒来时先对一下代:停写之后(锁屏 / 登出)绝不能再落一份。
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let starting: { id: string; done: Promise<void> } | null = null;
  const elsewhere = new Set<() => void>();

  const persisterFor = (id: string): Persister => {
    const key = recordKey(id);
    let latest: PersistedClient | null = null;
    return {
      persistClient: (next) => {
        latest = next;
        if (timer) return;
        const gen = generation;
        timer = setTimeout(() => {
          timer = null;
          if (gen !== generation || !latest) return;
          // 写不进去(配额满、结构化克隆不了某个值)就算了:持久化是锦上添花,不该打断页面。
          storage.put(key, latest, id).catch(() => {});
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
      persister: persisterFor(id),
      buster,
      dehydrateOptions: { shouldDehydrateQuery },
    });
  };

  const begin = async (queryClient: QueryClient, id: string, locked: boolean) => {
    stop();
    userId = id;
    client = queryClient;
    if (locked) paused = true;
    const gen = generation;
    const mine = recordKey(id);
    try {
      await storage.claim(id);
      const others = (await storage.keys()).filter(
        (k) => k.startsWith(RECORD_PREFIX) && k !== mine,
      );
      await Promise.all(others.map((k) => storage.del(k)));
      if (!paused) {
        await persistQueryClientRestore({
          queryClient,
          persister: persisterFor(id),
          maxAge: PERSIST_MAX_AGE_MS,
          buster,
        });
        freshenRestored(queryClient);
      } else {
        await storage.del(mine);
      }
    } catch {
      // IndexedDB 打不开(隐私模式、被禁用):不恢复,照常联网取。
    }
    // 等待期间可能已经被锁屏 / 登出叫停了(它们都会 stop,代数就变了)—— 那就别再开始写。
    if (gen === generation && !paused) subscribe(queryClient, id);
  };

  // 停写、忘掉是谁。盘由调用方决定清不清(本页登出清;收到别处的广播不清 —— 那边已经清了,
  // 本页再清一次可能正好抹掉紧接着登录进来的那份)。
  const drop = () => {
    stop();
    userId = null;
    paused = false;
    starting = null;
  };

  channel?.listen(() => {
    if (userId === null) return;
    drop();
    client?.clear();
    client = null;
    for (const fn of elsewhere) fn();
  });

  return {
    start: (queryClient, id, opts) => {
      if (userId === id && (unsubscribe || paused)) return Promise.resolve();
      // 同一个用户的上一次还在恢复(导航在它 resolve 之前又走了一遍鉴权):等那一次,别重来。
      if (starting?.id === id) return starting.done;
      const done = begin(queryClient, id, opts?.locked ?? false).finally(() => {
        if (starting?.done === done) starting = null;
      });
      starting = { id, done };
      return done;
    },
    clear: async () => {
      stop();
      paused = true;
      await storage.clear().catch(() => {});
    },
    resume: (queryClient) => {
      paused = false;
      if (!userId || unsubscribe) return;
      const id = userId;
      // 锁屏时 `clear` 连户主一起抹了 —— 先把户主记回来,之后的写才落得下。
      storage.claim(id).catch(() => {});
      subscribe(queryClient, id);
    },
    forget: async () => {
      const had = userId !== null;
      drop();
      client = null;
      await storage.clear().catch(() => {});
      // 只有「本页确实是登录着的那个人」才广播:收到广播后本页自己走到这里(路由鉴权发现会话没了)
      // 时不再回送一遍。
      if (had) channel?.announce();
    },
    onSignedOutElsewhere: (fn) => {
      elsewhere.add(fn);
      return () => elsewhere.delete(fn);
    },
  };
}

// —— 浏览器里的那一份 ——

const IDB_NAME = "folio-query-cache";
const IDB_STORE = "clients";
/** 户主标记的键。不以 `user:` 开头,所以「删掉别人的记录」那一步不会碰到它。 */
const OWNER_KEY = "owner";
const SIGN_OUT_CHANNEL = "folio-session";
const SIGNED_OUT = "signed-out";

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
    // 读户主与写记录在同一个 readwrite 事务里:与别的标签页的 `clear` 严格排先后(见接口注释)。
    put: async (key, value, owner) =>
      db()("readwrite", (os) => {
        const read = os.get(OWNER_KEY);
        read.onsuccess = () => {
          if (read.result === owner) os.put(value, key);
        };
        return promisifyRequest(os.transaction);
      }),
    claim: async (owner) => set(OWNER_KEY, owner, db()),
    del: async (key) => del(key, db()),
    keys: async () => keys<string>(db()),
    clear: async () => clear(db()),
  };
}

/** `BroadcastChannel` 上的登出广播;没有它的环境(老浏览器、服务端构建)返回 undefined。 */
function broadcastChannel(): SignOutChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const ch = new BroadcastChannel(SIGN_OUT_CHANNEL);
  return {
    announce: () => ch.postMessage(SIGNED_OUT),
    listen: (fn) =>
      ch.addEventListener("message", (e) => {
        if (e.data === SIGNED_OUT) fn();
      }),
  };
}

let browserPersistence: QueryPersistence | undefined;

/** 这个标签页的那一份(惰性建)。`__APP_VERSION__` 是 vite `define` 注入的构建期常量,单测里没有。 */
export function queryPersistence(): QueryPersistence {
  const buster = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unversioned";
  browserPersistence ??= createQueryPersistence({
    storage: idbStorage(),
    buster,
    channel: broadcastChannel(),
  });
  return browserPersistence;
}

/**
 * **锁屏**:停写、清盘,并把内存里此刻没人挂着的查询一并扔掉(锁屏时整棵页面已卸载,剩下挂着的
 * 只有外壳那几条 —— 组合清单、展示币种、设置)。解锁后页面重挂,数据重新拉。
 *
 * **版本号留在内存里**(review #24):它只是一个数,却是解锁后「数据在锁着的时候变没变」的比较基准 ——
 * 扔了它,解锁后第一次读到的号只能被记下而不会触发失效,解锁那一刻并发的一次写就漏掉了。
 */
export async function lockQueryCache(queryClient: QueryClient): Promise<void> {
  queryClient.removeQueries({
    predicate: (q) => !q.isActive() && !startsWith(q.queryKey, dataVersionKeys.all),
  });
  await queryPersistence().clear();
}

/** **登出 / 会话没了**:清盘 + 忘掉是谁 + 清空内存;别的标签页经广播各自照做(review #3)。 */
export async function forgetQueryCache(queryClient: QueryClient): Promise<void> {
  await queryPersistence().forget();
  queryClient.clear();
}
