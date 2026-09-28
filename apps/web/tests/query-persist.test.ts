import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountKeys, dataVersionKeys, syncKeys, tokenKeys } from "@/lib/queries/keys";
import {
  createQueryPersistence,
  isPersistedKey,
  type PersistStorage,
  type QueryPersistence,
} from "@/lib/queries/persist";

// 查询缓存落盘(FOL-94)。生产是 IndexedDB,这里换一个内存的 `PersistStorage` —— 要验的是
// 「存什么、按谁存、什么时候清」,不是 IndexedDB 本身。
//
// 钉的是安全那几条:换人登录不恢复上一个人的;锁屏 / 登出清空并停写(包括节流里挂着的那一次);
// 只存白名单里的域。

const THROTTLE = 1_000;
const USER_A = "user-a";
const USER_B = "user-b";

const memoryStorage = () => {
  const map = new Map<string, PersistedClient>();
  const storage: PersistStorage = {
    get: async (k) => map.get(k),
    set: async (k, v) => {
      map.set(k, v);
    },
    del: async (k) => {
      map.delete(k);
    },
    keys: async () => [...map.keys()],
    clear: async () => map.clear(),
  };
  return { map, storage };
};

const persistedKeys = (client: PersistedClient | undefined) =>
  (client?.clientState.queries ?? []).map((q) => q.queryKey);

let mem: ReturnType<typeof memoryStorage>;
let persistence: QueryPersistence;
const make = (buster = "build-1") =>
  createQueryPersistence({ storage: mem.storage, buster, throttleMs: THROTTLE });

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

  it("锁着开页面(restore: false)→ 不恢复,并把那份记录删掉", async () => {
    await seedA();
    const qc = new QueryClient();
    await make().start(qc, USER_A, { restore: false });

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

    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a3" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.size).toBe(0); // 锁着不写

    persistence.resume(qc);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a4" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
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
