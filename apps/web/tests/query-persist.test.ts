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

//

const THROTTLE = 1_000;
const USER_A = "user-a";
const USER_B = "user-b";

const OWNER = "owner";

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

describe("what is stored", () => {
  it("allowlist: data domains + version number stored; sync round and upstream search not stored", () => {
    expect(isPersistedKey(accountKeys.list("pf"))).toBe(true);
    expect(isPersistedKey(dataVersionKeys.all)).toBe(true);
    expect(isPersistedKey(tokenKeys.enrichment())).toBe(true);
    expect(isPersistedKey(tokenKeys.fiatOptions("en"))).toBe(true);
    expect(isPersistedKey(syncKeys.round("pf"))).toBe(false);
    expect(isPersistedKey(tokenKeys.search("btc"))).toBe(false);
  });

  it("one record per user, throttled disk writes, only the allowlist is written", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    qc.setQueryData([...syncKeys.round("pf")], { state: "running" });

    expect(mem.map.size).toBe(0);
    await vi.advanceTimersByTimeAsync(THROTTLE);

    expect([...mem.map.keys()]).toEqual([`user:${USER_A}`]);
    expect(mem.owner()).toBe(USER_A);
    expect(persistedKeys(mem.map.get(`user:${USER_A}`))).toEqual([accountKeys.list("pf")]);
  });
});

describe("restore", () => {
  const seedA = async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
  };

  it("same user reopens: restores the last data (no JSON: the Map in the cache goes to storage as is)", async () => {
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

  it("another user signs in: the previous user's data is not restored, and their record is deleted", async () => {
    await seedA();
    const qc = new QueryClient();
    await make().start(qc, USER_B);

    expect(qc.getQueryData([...accountKeys.list("pf")])).toBeUndefined();
    expect(mem.map.has(`user:${USER_A}`)).toBe(false);
  });

  it("new release shipped (buster changed): the whole old-shape cache is invalidated", async () => {
    await seedA();
    const qc = new QueryClient();
    await make("build-2").start(qc, USER_A);

    expect(qc.getQueryData([...accountKeys.list("pf")])).toBeUndefined();
  });

  it("page opened while locked: not restored, and that record is deleted", async () => {
    await seedA();
    const qc = new QueryClient();
    await make().start(qc, USER_A, { locked: true });

    expect(qc.getQueryData([...accountKeys.list("pf")])).toBeUndefined();
    expect(mem.map.size).toBe(0);
  });
});

describe("lock screen / sign out", () => {
  it("lock: wipes storage + stops writing (a throttled pending write does not land either); unlock resumes writing", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.size).toBe(1);

    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a2" }]);
    await persistence.clear();
    await vi.advanceTimersByTimeAsync(THROTTLE * 2);
    expect(mem.map.size).toBe(0);
    expect(mem.owner()).toBeUndefined();

    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a3" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.size).toBe(0);

    persistence.resume(qc);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a4" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.owner()).toBe(USER_A);
    expect(mem.map.has(`user:${USER_A}`)).toBe(true);
  });

  it("sign out: wipes storage + forgets who it was: later resume writes nothing", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);

    await persistence.forget();
    expect(mem.map.size).toBe(0);

    persistence.resume(qc);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a2" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.size).toBe(0);
  });

  it("locked during restore: writing does not start after the restore either", async () => {
    const qc = new QueryClient();
    const started = persistence.start(qc, USER_A);
    await persistence.clear();
    await started;

    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.size).toBe(0);
  });
});

describe("navigating while locked", () => {
  it("after lock, the same user runs start again (browser back / changed portfolio param): writing does not restart; only unlock writes", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    await persistence.clear();

    await persistence.start(qc, USER_A, { locked: false });
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE * 2);
    expect(mem.map.size).toBe(0);

    persistence.resume(qc);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a2" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    expect(mem.map.has(`user:${USER_A}`)).toBe(true);
  });

  it("page opened while locked: later navigation does not start writing either, until unlock", async () => {
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

describe("multiple tabs", () => {
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

  it("A signs out: B stops writing, clears memory, notifies the router; B's later cache events cannot write back to disk", async () => {
    const { a, b } = await openTabs();
    const toLogin = vi.fn();
    b.p.onSignedOutElsewhere(toLogin);

    b.qc.setQueryData([...accountKeys.list("pf")], [{ id: "a2" }]);
    await a.p.forget();
    await vi.advanceTimersByTimeAsync(0);

    expect(toLogin).toHaveBeenCalledTimes(1);
    expect(b.qc.getQueryCache().getAll()).toHaveLength(0);

    b.qc.setQueryData([...accountKeys.list("pf")], [{ id: "a3" }]);
    await vi.advanceTimersByTimeAsync(THROTTLE * 3);
    expect(mem.map.size).toBe(0);
  });

  it("the page that received the broadcast later finds the session gone itself (route auth): does not echo the broadcast", async () => {
    const { a, b } = await openTabs();
    const aHeard = vi.fn();
    a.p.onSignedOutElsewhere(aHeard);
    await a.p.forget();
    await vi.advanceTimersByTimeAsync(0);

    await b.p.forget();
    await vi.advanceTimersByTimeAsync(0);
    expect(aHeard).not.toHaveBeenCalled();
  });

  it("broadcast not yet arrived (or browser unsupported): the owner check catches it: B's pending write cannot land after A signs out", async () => {
    const a = { qc: new QueryClient(), p: make() };
    const b = { qc: new QueryClient(), p: make() };
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

describe("freshness of what was restored", () => {
  it("what the version number can vouch for is recorded as now; the enrichment dict carrying live prices keeps its original timestamp", async () => {
    vi.setSystemTime(new Date("2026-09-28T18:00:00Z"));
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    qc.setQueryData([...portfolioKeys.list()], { portfolios: [] });
    qc.setQueryData([...tokenKeys.enrichment()], { prices: {} });
    qc.setQueryData(dataVersionKeys.all, { version: 7 });
    await vi.advanceTimersByTimeAsync(THROTTLE);
    const savedAt = Date.now() - THROTTLE;

    vi.setSystemTime(new Date("2026-09-29T09:00:00Z"));
    const reopened = new QueryClient();
    await make().start(reopened, USER_A);
    const updatedAt = (key: readonly unknown[]) => reopened.getQueryState(key)?.dataUpdatedAt;

    expect(updatedAt(accountKeys.list("pf"))).toBe(Date.now());
    expect(updatedAt(portfolioKeys.list())).toBe(Date.now());
    expect(updatedAt(tokenKeys.enrichment())).toBe(savedAt);
    expect(updatedAt(dataVersionKeys.all)).toBe(savedAt);
  });

  it("restored via version number is always stale: even if it was fetched a second ago and is still in the dedupe window", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], []);
    qc.setQueryData(dataVersionKeys.all, { version: 7 });
    await vi.advanceTimersByTimeAsync(THROTTLE);

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

  it("marked invalid before being persisted (not mounted, only flagged): still stale after restore, refetches once mounted", async () => {
    const qc = new QueryClient();
    await persistence.start(qc, USER_A);
    qc.setQueryData([...accountKeys.list("pf")], [{ id: "a1" }]);
    qc.setQueryData([...portfolioKeys.list()], { portfolios: [] });
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

    const queryFn = vi.fn(async () => [{ id: "a1" }, { id: "a2" }]);
    await reopened.fetchQuery({
      queryKey: [...accountKeys.list("pf")],
      queryFn,
      staleTime: 15 * 60_000,
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
    const portfolios = cache.find({ queryKey: portfolioKeys.list(), exact: true });
    expect(portfolios?.isStaleByTime(15 * 60_000)).toBe(false);
  });
});
