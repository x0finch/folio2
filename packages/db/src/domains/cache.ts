import { and, eq, inArray } from "drizzle-orm";
import { Clock, Effect, Option } from "effect";
import { chunk, DbClient } from "../client";
import type { Drizzle } from "../connect";
import { CurrentUser } from "../current-user";
import { userCache } from "../schema";

// per-user 的 KV 缓存(#199)。**通用读写这一条路上有三种键**(`warm` / `fx:<币种>` /
// `platform:<键>`,键的形状归 oracle 的 cache.ts,本文件不解释键;`defi-logo:<协议>` 那种是 app
// 自己的一片)。同一张表上还住着第四种键 —— 同步轮(`sync-round:<portfolioId>`,ADR 0048),
// **但它不走这个 store**:它的写入是带轮 id 条件的单语句,`put(key, value)` 表达不了
// (见 domains/sync-rounds.ts)。值是 JSON,db 当不透明 blob。
//
// 第五种键是预计算的 24h 盈亏(`gain24h:<组合>[:<pin>]` / `gain24h-accounts:<组合>`,ADR 0049)。
// 它**走这个 store**:同步收官时一次 `putMany` 把一个组合的全部维度原子换新,读接口一次
// `get` 直出 —— 那正是这两个动词的形状。键的形状归 app(`server/portfolio/gain.ts`)。
//
// **过期不删、读出带 stale** —— 与价同一套 SWR 语义:展示先给旧的,调用方决定要不要后台刷。
// 整张删空功能不坏,只是下次访问慢一点。
//
// **批量那两个是主路径**:展示一次要这个用户的全部平台键、预热一次写十来个币种的汇率。
// 逐键往返会把 1 次 D1 变成 N 次,而读那 N 次就落在总览的关键路径上。
// 分块见 ../client.ts 末尾(`IN` 列表受 D1 绑定参数上限约束;这里每块还要多带一个 user_id)。
//
// 留 userId 的理由:per-user 缓存只装这个用户实际碰到的(他选的币种、他有持仓的那几条链),
// 全局一份就得装所有人的并集。#202 起它取代 fx_rates + platforms 两张全局表。
//
// **时间走 `Clock`**(以前是 `opts.now` —— 一个只有测试会传的字段);出网口是 `DbClient`
// 那一个服务,`env` 不再出现在签名里。

/** 一次写:键 + 值 + 各自的 TTL。 */
export interface CacheWrite {
  key: string;
  value: unknown;
  ttlMs: number;
}

/** 过期不删、读出带 stale —— 与价的 SWR 同一套语义,由调用方决定要不要用旧值。 */
export interface CacheEntry {
  value: unknown;
  stale: boolean;
}

/** 这一层的契约 —— 从实现推导,不另抄一份签名。 */
export type CacheStore = Effect.Effect.Success<typeof makeUserCacheStore>;

// 一条 upsert 语句。`put` 与 `putMany` 共用同一份键/值口径 —— 两个动词写出来的行必须一样。
const upsert = (db: Drizzle, userId: string, w: CacheWrite, now: number) => {
  const v = JSON.stringify(w.value);
  const expiresAt = now + w.ttlMs;
  return db
    .insert(userCache)
    .values({ userId, k: w.key, v, expiresAt })
    .onConflictDoUpdate({ target: [userCache.userId, userCache.k], set: { v, expiresAt } });
};

export const makeUserCacheStore = Effect.gen(function* () {
  const client = yield* DbClient;
  const userId = yield* CurrentUser;

  // 存进去的一定是 JSON.stringify 的产物;真读到坏值就当没有这条 ——
  // 下次访问会照常回源覆盖,不该让一条脏缓存把整个页面弄崩。
  const decode = (row: { v: string; expiresAt: number }, now: number): CacheEntry | undefined => {
    try {
      return { value: JSON.parse(row.v), stale: row.expiresAt <= now };
    } catch {
      return undefined;
    }
  };

  return {
    /** 单键。miss 与坏值同待遇 → `none`。 */
    get: (key: string): Effect.Effect<Option.Option<CacheEntry>> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* client.query((db) =>
          db
            .select({ v: userCache.v, expiresAt: userCache.expiresAt })
            .from(userCache)
            .where(and(eq(userCache.userId, userId), eq(userCache.k, key))),
        );
        const row = rows[0];
        return Option.fromNullable(row ? decode(row, now) : undefined);
      }),

    /** 批量。**miss 的键不出现在结果里**(同 `findByRefs` 的口径)。 */
    getMany: (keys: readonly string[]): Effect.Effect<Map<string, CacheEntry>> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const out = new Map<string, CacheEntry>();
        // 去重后分块:一块一条 `WHERE user_id = ? AND k IN (…)`,走 (user_id, k) 主键。
        // **顺序跑**(`Effect.forEach` 的默认档)—— 与迁移前逐字一致:一片装 90 个键,
        // 多片本来就少见,要并发得先量一次真实批量。区别只是现在这句话写在代码里。
        const parts = chunk([...new Set(keys)]).filter((p) => p.length > 0);
        const batches = yield* Effect.forEach(parts, (part) =>
          client.query((db) =>
            db
              .select({ k: userCache.k, v: userCache.v, expiresAt: userCache.expiresAt })
              .from(userCache)
              .where(and(eq(userCache.userId, userId), inArray(userCache.k, part))),
          ),
        );
        for (const rows of batches) {
          for (const row of rows) {
            const entry = decode(row, now);
            if (entry) out.set(row.k, entry); // 坏值与 miss 同待遇:不出现在结果里
          }
        }
        return out;
      }),

    put: (key: string, value: unknown, ttlMs: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* client.query((db) => upsert(db, userId, { key, value, ttlMs }, now));
      }),

    // 一次写多个键,各带自己的 TTL,**一个批次发出去**(D1 没有交互式事务,batch 是它的原子多写)。
    putMany: (writes: readonly CacheWrite[]): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* client.batch((db) => writes.map((w) => upsert(db, userId, w, now)));
      }),
  };
});
