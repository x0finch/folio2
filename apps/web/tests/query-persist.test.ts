import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STALE_TIME } from "@/lib/queries/constants";
import {
  accountKeys,
  dataVersionKeys,
  portfolioKeys,
  syncKeys,
  tokenKeys,
} from "@/lib/queries/keys";
import {
  createQueryPersistence,
  isPersistedKey,
  type PersistStorage,
  type QueryPersistence,
  type SignOutChannel,
} from "@/lib/queries/persist";

// 查询缓存落盘(FOL-94)。生产是 IndexedDB,这里换一个内存的 `PersistStorage` —— 要验的是
// 「存什么、按谁存、什么时候清」,不是 IndexedDB 本身。
//
// 钉的是安全那几条:换人登录不恢复上一个人的;锁屏 / 登出清空并停写(包括节流里挂着的那一次);
// 只存白名单里的域。

const THROTTLE = 1_000;
const USER_A = "user-a";
const USER_B = "user-b";

const OWNER = "owner";

// 内存版 `PersistStorage`:户主标记与记录同住一张表,`clear` 一起抹掉 —— 与 IndexedDB 那份同形。
const memoryStorage = () => {
  const map = new Map<string, PersistedClient>();
  let owner: string | undefined;
  const storage: PersistStorage = {
    get: async (k) => map.get(k),
    put: async (k, v, who) => {
      if (owner === who) map.set(k, v);
    },
    claim: async (who) => {
      owner = who;
    },
    del: async (k) => {
      map.delete(k);
    },
    keys: async () => [...map.keys(), ...(owner ? [OWNER] : [])],
    clear: async () => {
      map.clear();
      owner = undefined;
    },
  };
  return { map, storage, owner: () => owner };
};

// 假 BroadcastChannel:同一个 hub 上的频道互相送达,不回送给自己;送达是异步的(与真的一样)。
const channelHub = () => {
  const listeners: { self: object; fn: () => void }[] = [];
  return (): SignOutChannel => {
    const self = {};
    return {
      announce: () => {
        for (const l of listeners) if (l.self !== self) setTimeout(l.fn, 0);
      },
      listen: (fn) => {
        listeners.push({ self, fn });
      },
    };
  };
};

const persistedKeys = (client: PersistedClient | undefined) =>
  (client?.clientState.queries ?? []).map((q) => q.queryKey);

let mem: ReturnType<typeof memoryStorage>;
let persistence: QueryPersistence;
const make = (buster = "build-1", channel?: SignOutChannel) =>
  createQueryPersistence({ storage: mem.storage, buster, channel, throttleMs: THROTTLE });

beforeEach(() => {
  vi.useFakeTimers();
  mem = memoryStorage();
  persistence = make();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("存什么", () => {
  it("白名单:数据域 + 版本号存;同步轮与上游搜索不存", () => {
    expect(isPersistedKey(accountKeys.list("pf"))).toBe(true);
    expect(isPersistedKey(dataVersionKeys.all)).toBe(true);
    expect(isPersistedKey(tokenKeys.enrichment())).toBe(true);
    expect(isPersistedKey(tokenKeys.fiatOptions("en"))).toBe(true);
    expect(isPersistedKey(syncKeys.round("pf"))).toBe(false);
    expect(isPersistedKey(tokenKeys.search("btc"))).toBe(false);
  });

  it("按用户一条记录,节流写盘,只写白名单里的", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    qc.setQueryData([...syncKeys.round("pf")], { state: "running" });

    expect(mem.map.size).toBe(0); // 还在节流窗口里
    await vi.advanceTimersByTimeAsync(THROTTLE);

    expect([...mem.map.keys()]).toEqual([`user:${USER_A}`]);
    expect(mem.owner()).toBe(USER_A);
    expect(persistedKeys(mem.map.get(`user:${USER_A}`))).toEqual([accountKeys.list("pf")]);
  });
});

describe("恢复", () => {
  const seedA = async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
  };

  it("同一个用户重开 → 恢复上次的数据(不经 JSON:缓存里的 Map 原样交给存储)", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...tokenKeys.enrichment()], { enriched: new Map([["t", 1]]) });
    await vi.advanceTimersByTimeAsync(THROTTLE);

    const reopened = new QueryClient();
    await make().start(reopened, USER_A);
    expect(reopened.getQueryData([...tokenKeys.enrichment()])).toEqual({
      enriched: new Map([["t", 1]]),
    });
  });

  it("换人登录 → 不恢复上一个人的,而且把他的记录删掉", async () => {
    await seedA();
    const qc = new QueryClient();
    await make().start(qc, USER_B);

    expect(qc.getQueryData([...accountKeys.list("pf")])).toBeUndefined();
    expect(mem.map.has(`user:${USER_A}`)).toBe(false);
  });

  it("发了新版(buster 变了)→ 旧形状的缓存整份作废", async () => {
    await seedA();
    const qc = new QueryClient();
    await make("build-2").start(qc, USER_A);

    expect(qc.getQueryData([...accountKeys.list("pf")])).toBeUndefined();
  });

  it("锁着开页面(locked)→ 不恢复,并把那份记录删掉", async () => {
    await seedA();
    const qc = new QueryClient();
    await make().start(qc, USER_A, { locked: true });

    expect(qc.getQueryData([...accountKeys.list("pf")])).toBeUndefined();
    expect(mem.map.size).toBe(0);
  });
});

describe("锁屏 / 登出", () => {
  it("锁屏:清盘 + 停写(节流里挂着的那次也不落);解锁接着写", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.size).toBe(1);

    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a2" }]); // 节流窗口里挂着一次写
    await persistence.clear();
    await vi.advanceTimersByTimeAsync(THROTTLE * 2);
    expect(mem.map.size).toBe(0);
    expect(mem.owner()).toBeUndefined(); // 清盘连户主一起抹

    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a3" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.size).toBe(0); // 锁着不写

    persistence.resume(qc);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a4" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.owner()).toBe(USER_A); // 解锁后户主记回来,写才落得下
    expect(mem.map.has(`user:${USER_A}`)).toBe(true);
  });

  it("登出:清盘 + 忘掉是谁 —— 之后的 resume 什么都不写", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);

    await persistence.forget();
    expect(mem.map.size).toBe(0);

    persistence.resume(qc); // 锁屏卸载时的清理会调它
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a2" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.size).toBe(0);
  });

  it("恢复途中被锁 → 恢复完也不开始写", async () => {
    const qc = new QueryClient();
    const started = persistence.start(qc, USER_A);
    await persistence.clear();
    await started;

    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.size).toBe(0);
  });
});

describe("锁着的时候导航(review #14)", () => {
  it("锁屏后同一个用户再走一遍 start(浏览器后退 / 换组合参数)→ 不重新开写;解锁才写", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    await persistence.clear(); // 锁上

    await persistence.start(qc, USER_A, { locked: false }); // 锁标志已被别的标签页解锁清掉也一样
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE * 2);
    expect(mem.map.size).toBe(0);

    persistence.resume(qc);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a2" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.has(`user:${USER_A}`)).toBe(true);
  });

  it("锁着开页面 → 之后的导航也不开写,直到解锁", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A, { locked: true });
    await persistence.start(qc, USER_A, { locked: true });
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE * 2);
    expect(mem.map.size).toBe(0);

    persistence.resume(qc);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a2" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.has(`user:${USER_A}`)).toBe(true);
  });
});

describe("多个标签页(review #3)", () => {
  const openTabs = async () => {
    const hub = channelHub();
    const a = { qc: new QueryClient(), p: make("build-1", hub()) };
    const b = { qc: new QueryClient(), p: make("build-1", hub()) };
    await a.p.start(a.qc, USER_A);
    await b.p.start(b.qc, USER_A);
    for (const tab of [a, b]) tab.qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.has(`user:${USER_A}`)).toBe(true);
    return { a, b };
  };

  it("A 登出 → B 停写、清空内存、通知路由;之后 B 的缓存事件写不回盘", async () => {
    const { a, b } = await openTabs();
    const toLogin = vi.fn();
    b.p.onSignedOutElsewhere(toLogin);

    b.qc.setQueryData([...accountKeys.list("pf")], [{ id: "a2" }]); // B 节流窗口里挂着一次写
    await a.p.forget();
    await vi.advanceTimersByTimeAsync(0);

    expect(toLogin).toHaveBeenCalledTimes(1);
    expect(b.qc.getQueryCache().getAll()).toHaveLength(0);

    // B 的版本号轮询失败 / 聚焦重拉:缓存事件照来,盘上仍然没有这个用户。
    b.qc.setQueryData([...accountKeys.list("pf")], [{ id: "a3" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE * 3);
    expect(mem.map.size).toBe(0);
  });

  it("收到广播的那一页后来自己发现会话没了(路由鉴权)→ 不再回送广播", async () => {
    const { a, b } = await openTabs();
    const aHeard = vi.fn();
    a.p.onSignedOutElsewhere(aHeard);
    await a.p.forget();
    await vi.advanceTimersByTimeAsync(0);

    await b.p.forget();
    await vi.advanceTimersByTimeAsync(0);
    expect(aHeard).not.toHaveBeenCalled();
  });

  it("广播还没到(或浏览器不支持)→ 户主检查兜住:A 登出之后 B 挂着的那次写也落不下", async () => {
    const a = { qc: new QueryClient(), p: make() };
    const b = { qc: new QueryClient(), p: make() }; // 没有频道
    await a.p.start(a.qc, USER_A);
    await b.p.start(b.qc, USER_A);

    b.qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await a.p.forget();
    await vi.advanceTimersByTimeAsync(THROTTLE * 2);
    b.qc.setQueryData([...accountKeys.list("pf")], [{ id: "a2" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE * 2);

    expect(mem.map.size).toBe(0);
  });
});

describe("恢复出来的新不新鲜(review #13)", () => {
  it("版本号担保得了的记成现在;带现价的富化字典保留原来的时间戳", async () => {
    vi.setSystemTime(new Date("2026-09-28T18:00:00Z"));
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    qc.setQueryData([...portfolioKeys.list()], { portfolios: [] });
    qc.setQueryData([...tokenKeys.enrichment()], { prices: {} });
    qc.setQueryData(dataVersionKeys.all, { version: 7 });
    await vi.advanceTimersByTimeAsync(THROTTLE);
    const savedAt = Date.now() - THROTTLE;

    vi.setSystemTime(new Date("2026-09-29T09:00:00Z")); // 第二天早上重开
    const reopened = new QueryClient();
    await make().start(reopened, USER_A);
    const updatedAt = (key: readonly unknown[]) => reopened.getQueryState(key)?.dataUpdatedAt;

    expect(updatedAt(accountKeys.list("pf"))).toBe(Date.now());
    expect(updatedAt(portfolioKeys.list())).toBe(Date.now());
    expect(updatedAt(tokenKeys.enrichment())).toBe(savedAt);
    // 版本号自己也不动 —— 它得照旧过期,挂上时去问服务端。
    expect(updatedAt(dataVersionKeys.all)).toBe(savedAt);
  });

  it("版本号恢复出来一律过期 —— 哪怕它才拉了一秒,还在去重窗里", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], []);
    qc.setQueryData(dataVersionKeys.all, { version: 7 });
    await vi.advanceTimersByTimeAsync(THROTTLE);

    // 紧接着刷新:节流里最后那次写盘(加完账户之后的那份)没落,盘上是改之前的数据 + 几秒前的号。
    const reopened = new QueryClient();
    await make().start(reopened, USER_A);
    const version = reopened.getQueryCache().find({ queryKey: dataVersionKeys.all, exact: true });
    expect(version?.isStaleByTime(STALE_TIME.dataVersion)).toBe(true);

    const queryFn = vi.fn(async () => ({ version: 8 }));
    await reopened.fetchQuery({
      queryKey: dataVersionKeys.all,
      queryFn,
      staleTime: STALE_TIME.dataVersion,
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("落盘前已被标失效的(没挂着、只打了标记)→ 恢复后仍旧过期,挂上就重拉(review R2-#1)", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    qc.setQueryData([...portfolioKeys.list()], { portfolios: [] });
    // 版本号变了之后的失效:没挂着的查询只被打上标记,不重拉。
    await qc.invalidateQueries({ queryKey: accountKeys.all });
    await vi.advanceTimersByTimeAsync(THROTTLE * 2);
    const saved = mem.map.get(`user:${USER_A}`);
    const savedState = saved?.clientState.queries.find(
      (q) => JSON.stringify(q.queryKey) === JSON.stringify(accountKeys.list("pf")),
    )?.state;
    expect(savedState?.isInvalidated).toBe(true);

    const reopened = new QueryClient();
    await make().start(reopened, USER_A);
    const cache = reopened.getQueryCache();
    const accounts = cache.find({ queryKey: accountKeys.list("pf"), exact: true });
    expect(accounts?.state.isInvalidated).toBe(true);
    expect(accounts?.isStaleByTime(15 * 60_000)).toBe(true);

    // 挂上就重拉。
    const queryFn = vi.fn(async () => [{ id: "a1" }, { id: "a2" }]);
    await reopened.fetchQuery({
      queryKey: [...accountKeys.list("pf")],
      queryFn,
      staleTime: 15 * 60_000,
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
    // 没被标过的照旧记成新鲜。
    const portfolios = cache.find({ queryKey: portfolioKeys.list(), exact: true });
    expect(portfolios?.isStaleByTime(15 * 60_000)).toBe(false);
  });
});
