import type { CacheEntry, CacheStore, CacheWrite } from "@folio/oracle-basic";
import { and, eq, inArray } from "drizzle-orm";
import type { AsPromise } from "./async-port";
import { batchWrite, chunk } from "./cache-util";
import { type DbEnv, getDb } from "./client";
import { userCache } from "./schema";

// `CacheStore` 的 D1 实现(#199)。per-user 的 KV,只三种键(`warm` / `fx:<币种>` / `platform:<键>`,
// 键的形状归 oracle 的 cache.ts,本文件不解释键)。值是 JSON,db 当不透明 blob。
//
// **过期不删、读出带 stale** —— 与价同一套 SWR 语义:展示先给旧的,调用方决定要不要后台刷。
// 整张删空功能不坏,只是下次访问慢一点。
//
// **批量那两个是主路径**:展示一次要这个用户的全部平台键、预热一次写十来个币种的汇率。
// 逐键往返会把 1 次 D1 变成 N 次,而读那 N 次就落在总览的关键路径上。
// 分块见 cache-util(`IN` 列表受 D1 绑定参数上限约束;这里每块还要多带一个 user_id)。
//
// 留 userId 的理由:per-user 缓存只装这个用户实际碰到的(他选的币种、他有持仓的那几条链),
// 全局一份就得装所有人的并集。#202 起它取代 fx_rates + platforms 两张全局表。

export interface UserCacheStoreOpts {
  userId: string;
  now?: () => number;
}

export function createUserCacheStore(env: DbEnv, opts: UserCacheStoreOpts): AsPromise<CacheStore> {
  const db = getDb(env);
  const { userId } = opts;
  const now = opts.now ?? (() => Date.now());

  // 存进去的一定是 JSON.stringify 的产物;真读到坏值就当没有这条 ——
  // 下次访问会照常回源覆盖,不该让一条脏缓存把整个页面弄崩。
  const decode = (row: { v: string; expiresAt: number }): CacheEntry | undefined => {
    try {
      return { value: JSON.parse(row.v), stale: row.expiresAt <= now() };
    } catch {
      return undefined;
    }
  };

  const upsert = (w: CacheWrite) => {
    const v = JSON.stringify(w.value);
    const expiresAt = now() + w.ttlMs;
    return db
      .insert(userCache)
      .values({ userId, k: w.key, v, expiresAt })
      .onConflictDoUpdate({ target: [userCache.userId, userCache.k], set: { v, expiresAt } });
  };

  return {
    async get(key) {
      const rows = await db
        .select({ v: userCache.v, expiresAt: userCache.expiresAt })
        .from(userCache)
        .where(and(eq(userCache.userId, userId), eq(userCache.k, key)));
      const row = rows[0];
      return row ? decode(row) : undefined;
    },

    async getMany(keys) {
      const out = new Map<string, CacheEntry>();
      // 去重后分块:一块一条 `WHERE user_id = ? AND k IN (…)`,走 (user_id, k) 主键。
      for (const part of chunk([...new Set(keys)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({ k: userCache.k, v: userCache.v, expiresAt: userCache.expiresAt })
          .from(userCache)
          .where(and(eq(userCache.userId, userId), inArray(userCache.k, part)));
        for (const row of rows) {
          const entry = decode(row);
          if (entry) out.set(row.k, entry); // 坏值与 miss 同待遇:不出现在结果里
        }
      }
      return out;
    },

    async put(key, value, ttlMs) {
      await upsert({ key, value, ttlMs });
    },

    async putMany(writes) {
      // 一个批次发出去(D1 没有交互式事务,batch 是它的原子多写)。
      await batchWrite(db, writes.map(upsert));
    },
  };
}
