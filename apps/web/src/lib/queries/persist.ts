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

// Query cache persisted to IndexedDB (`@tanstack/query-persist-client-core` + `idb-keyval`): a reopened page paints from
// the last data and asks only the version number (`data-version.ts`), cutting cold-open server fn calls on the free
// plan's daily request budget. Not `query-async-storage-persister`: it stores JSON strings and the cache holds Maps
// (the enrichment dictionary), which IndexedDB's structured clone keeps.
// Security: the API returns no credentials (`listAccounts` only exposes safeView), so only that is stored. Lock and
// sign-out clear the store and stop writing; sign-out is broadcast to other tabs, and writes re-check the owner so no
// tab can write back after another signs out.
// One record per user (`user:<id>`); other users' records are deleted on start, so a different login on the same
// machine never restores someone else's portfolio. `buster` is the build version, so old-shape caches die on release.

/** Records older than this are dropped on restore (also the floor for in-memory `gcTime`, see router). */
export const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Write throttle: a cold open emits dozens of cache events and rewriting the whole store for each isn't worth it. */
const PERSIST_THROTTLE_MS = 1_000;

/**
 * Minimal persistence interface (IndexedDB in production, in-memory in tests). `put` writes only while the owner is
 * still this user, checked in the same transaction as the write: transactions run in open order, so a `put` queued
 * after another tab's `clear` sees no owner even if this tab hasn't got the broadcast yet.
 */
export interface PersistStorage {
  get: (key: string) => Promise<PersistedClient | undefined>;
  /** Writes only if the owner is still `owner` (same transaction as the owner read); otherwise no-op. */
  put: (key: string, value: PersistedClient, owner: string) => Promise<void>;
  /** Records `owner` as the owner. */
  claim: (owner: string) => Promise<void>;
  del: (key: string) => Promise<void>;
  keys: () => Promise<string[]>;
  /** Clears the whole store: records and the owner marker. */
  clear: () => Promise<void>;
}

/**
 * Cross-tab sign-out broadcast (`BroadcastChannel` in production, a fake in tests). The session cookie is shared by
 * the whole browser, so other tabs' caches must stop writing back once one tab signs out.
 */
export interface SignOutChannel {
  /** Tells other tabs the session is gone (not echoed to self). */
  announce: () => void;
  /** Calls `fn` when another tab announces sign-out. */
  listen: (fn: () => void) => void;
}

// Persisted by domain-prefix allowlist: sync rounds (live progress) and upstream search results aren't stored. An
// allowlist so a new domain isn't persisted by default.
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

// Restored queries vouched for by the version number (those `REFRESH_MAP["data.changed"]` invalidates) get their
// timestamp set to now: an unchanged version means they're correct, so no mass refetch on reopen. Exception: prices in
// the enrichment dictionary refresh by TTL without bumping the version, so they keep their original timestamp (FX
// rates likewise follow their own staleTime).
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
 * Sets the timestamp of freshly restored, version-vouched queries to now. Skips already-invalidated ones: an unmounted
 * query is only marked `isInvalidated`, and `setQueryData` would clear the mark while the version matches, presenting
 * known-stale data as fresh for 15 minutes.
 */
function freshenRestored(queryClient: QueryClient) {
  // The version query is the reverse: restored data is always stale, so a cold open asks the server first. Keeping the
  // original timestamp isn't enough: its dedupe window is a few seconds and writes are throttled, so a refresh right
  // after a change restores pre-change data with a recent version and never asks.
  const version = queryClient.getQueryCache().find({ queryKey: dataVersionKeys.all, exact: true });
  version?.setState({ isInvalidated: true });
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
   * Starts persisting for this user: records the owner, deletes others' records, restores the last cache (unless locked),
   * then throttles writes. Repeat calls for the same user are no-ops. `locked`: don't restore, delete the on-disk copy and
   * don't start writing until `resume`; navigation during lock also reaches here and must not reopen writes.
   */
  start: (queryClient: QueryClient, userId: string, opts?: { locked?: boolean }) => Promise<void>;
  /** Lock: stop writing and clear the disk; `start` won't reopen writes before `resume`. */
  clear: () => Promise<void>;
  /** Unlock: resume writing for the same user (no restore, the disk is empty). */
  resume: (queryClient: QueryClient) => void;
  /** Sign-out / session gone: stop, clear, forget the user, and broadcast so other tabs stop writing and empty memory. */
  forget: () => Promise<void>;
  /** Called after another tab signed out and this one stopped and emptied memory (the route sends this page to login); returns unsubscribe. */
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
  /** Cross-tab sign-out broadcast; without it (tests, no BroadcastChannel) only the owner check guards. */
  channel?: SignOutChannel;
  throttleMs?: number;
}): QueryPersistence {
  let userId: string | null = null;
  let client: QueryClient | null = null;
  let unsubscribe: (() => void) | null = null;
  // Set by `clear`, cleared by `resume`; while set, `start` never begins writing.
  let paused = false;
  // Bumped on every stop: a throttled pending write checks it on wake so none lands after lock / sign-out.
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
          // A failed write (quota, uncloneable value) is ignored: persistence is best-effort.
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
      // IndexedDB unavailable (private mode, disabled): skip restore and fetch normally.
    }
    // Lock / sign-out during the wait bumped the generation; don't start writing then.
    if (gen === generation && !paused) subscribe(queryClient, id);
  };

  // Stops writing and forgets the user. The caller decides whether to clear the disk: not on another tab's broadcast,
  // which has already cleared and could wipe a login that just happened.
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
      // The same user's previous start is still restoring (navigation re-ran auth): wait for it.
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
      // Lock cleared the owner too: re-claim it so later writes can land.
      storage.claim(id).catch(() => {});
      subscribe(queryClient, id);
    },
    forget: async () => {
      const had = userId !== null;
      drop();
      client = null;
      await storage.clear().catch(() => {});
      // Broadcast only if this tab was actually logged in, so the tab that heard it doesn't echo.
      if (had) channel?.announce();
    },
    onSignedOutElsewhere: (fn) => {
      elsewhere.add(fn);
      return () => elsewhere.delete(fn);
    },
  };
}

const IDB_NAME = "folio-query-cache";
const IDB_STORE = "clients";
/** Owner marker key; not `user:`-prefixed, so "delete others' records" never touches it. */
const OWNER_KEY = "owner";
const SIGN_OUT_CHANNEL = "folio-session";
const SIGNED_OUT = "signed-out";

/** `PersistStorage` over IndexedDB, opened lazily: `createStore` calls `indexedDB.open` immediately and this module is also imported by the server shell build and node tests. */
function idbStorage(): PersistStorage {
  let store: UseStore | undefined;
  const db = () => {
    store ??= createStore(IDB_NAME, IDB_STORE);
    return store;
  };
  // All async: without IndexedDB `createStore` throws synchronously, and wrapping it makes it reject into the caller's `.catch`.
  return {
    get: async (key) => get<PersistedClient>(key, db()),
    // Owner read and record write share one readwrite transaction, ordering strictly against other tabs' `clear`.
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

/** Sign-out broadcast over `BroadcastChannel`; undefined where unavailable (old browsers, server build). */
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

/** This tab's instance (lazy). `__APP_VERSION__` is a vite `define` build constant, absent in unit tests. */
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
 * Lock: stop writing, clear the disk, and drop in-memory queries nobody observes (the page is unmounted, leaving only the
 * shell's). The version number stays in memory as the baseline for "did data change while locked": dropping it would
 * miss a write that raced with unlock.
 */
export async function lockQueryCache(queryClient: QueryClient): Promise<void> {
  queryClient.removeQueries({
    predicate: (q) => !q.isActive() && !startsWith(q.queryKey, dataVersionKeys.all),
  });
  await queryPersistence().clear();
}

/** Sign-out / session gone: clear the disk, forget the user, empty memory; other tabs do the same via broadcast. */
export async function forgetQueryCache(queryClient: QueryClient): Promise<void> {
  await queryPersistence().forget();
  queryClient.clear();
}
