import type { CacheEntry, CacheStore } from "@folio/oracle2-basic";
import { and, eq } from "drizzle-orm";
import { type DbEnv, getDb } from "./client";
import { userCache } from "./schema";

// `CacheStore` 的 D1 实现(#199)。per-user 的 KV,只三种键(`warm` / `fx:<币种>` / `platform:<键>`,
// 键的形状归 oracle2 的 cache.ts,本文件不解释键)。值是 JSON,db 当不透明 blob。
//
// **过期不删、读出带 stale** —— 与价同一套 SWR 语义:展示先给旧的,调用方决定要不要后台刷。
// 整张删空功能不坏,只是下次访问慢一点。
//
// 留 userId 的理由:per-user 缓存只装这个用户实际碰到的(他选的币种、他有持仓的那几条链),
// 全局一份就得装所有人的并集。#202 起它取代 fx_rates + platforms 两张全局表。

export interface UserCacheStoreOpts {
  userId: string;
  now?: () => number;
}

export function createUserCacheStore(env: DbEnv, opts: UserCacheStoreOpts): CacheStore {
  const db = getDb(env);
  const { userId } = opts;
  const now = opts.now ?? (() => Date.now());

  return {
    async get(key): Promise<CacheEntry | undefined> {
      const rows = await db
        .select({ v: userCache.v, expiresAt: userCache.expiresAt })
        .from(userCache)
        .where(and(eq(userCache.userId, userId), eq(userCache.k, key)));
      const row = rows[0];
      if (!row) return undefined;
      let value: unknown;
      try {
        value = JSON.parse(row.v);
      } catch {
        // 存进去的一定是 JSON.stringify 的产物;真读到坏值就当没有这条 ——
        // 下次访问会照常回源覆盖,不该让一条脏缓存把整个页面弄崩。
        return undefined;
      }
      return { value, stale: row.expiresAt <= now() };
    },

    async put(key, value, ttlMs) {
      await db
        .insert(userCache)
        .values({
          userId,
          k: key,
          v: JSON.stringify(value),
          expiresAt: now() + ttlMs,
        })
        .onConflictDoUpdate({
          target: [userCache.userId, userCache.k],
          set: { v: JSON.stringify(value), expiresAt: now() + ttlMs },
        });
    },
  };
}
