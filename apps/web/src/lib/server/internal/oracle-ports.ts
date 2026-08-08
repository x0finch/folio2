import type {
  createGlobalTokenRefIndexStore,
  createUserCacheStore,
  createUserTokenPriceStore,
  createUserTokenStore,
} from "@folio/db";
import type {
  CacheStore,
  GlobalTokenRefIndexStore,
  TokenPriceStore,
  TokenStore,
} from "@folio/oracle-basic";
import { Effect, Option } from "effect";

// **Promise ↔ Effect 的缝,全仓只有这一处。**
//
// 参考层的端口是 Effect 形状(#362 第 4 站),而 `@folio/db` 还是 Promise 形状(第 5 站,而且
// epic 里写了判据:收益小的包可以永远不迁)。缝落在装配点这一侧,理由是这个目录本来就是
// 「唯一同时认识 D1 与上游的地方」;db 那边一行没改,只是把返回类型从端口**推导**出来
// (见 `@folio/db` 的 `async-port.ts`),所以契约仍然只有一份。
//
// 两个决定写在这里:
//   · **`Effect.promise` 而不是 `Effect.tryPromise`** —— D1 挂了这一层没人救得了它(今天也没有
//     任何调用点 catch 它,行为就是整个请求 500)。所以它走 **defect**:一路冒到 `runPromise`,
//     与迁移前逐字一致。把它做成 typed error 只会迫使每个调用点写一遍 `catchAll` 再扔回去。
//   · **`Option.fromNullable`** —— db 回 `undefined` / `null`,端口那侧要 `Option`。两种空值都吃,
//     所以 db 不必为了对齐 Option 而改任何一行(`refreshedAt` 现在回的就是 `null`)。

export const tokenStorePort = (s: ReturnType<typeof createUserTokenStore>): TokenStore => ({
  findByRefs: (refs) => Effect.promise(() => s.findByRefs(refs)),
  create: (seed, refs) => Effect.promise(() => s.create(seed, refs)),
  linkRef: (tokenId, ref) => Effect.promise(() => s.linkRef(tokenId, ref)),
  merge: (from, into) => Effect.promise(() => s.merge(from, into)),
  getByIds: (ids) => Effect.promise(() => s.getByIds(ids)),
  getById: (id) =>
    Effect.map(
      Effect.promise(() => s.getById(id)),
      Option.fromNullable,
    ),
  fillInfo: (tokenId, patch) => Effect.promise(() => s.fillInfo(tokenId, patch)),
  putInfo: (rows, ttlMs) => Effect.promise(() => s.putInfo(rows, ttlMs)),
  candidatesBySymbol: (symbol) => Effect.promise(() => s.candidatesBySymbol(symbol)),
});

export const tokenPriceStorePort = (
  s: ReturnType<typeof createUserTokenPriceStore>,
): TokenPriceStore => ({
  getByIds: (ids) => Effect.promise(() => s.getByIds(ids)),
  put: (prices, ttlMs) => Effect.promise(() => s.put(prices, ttlMs)),
  getDaily: (tokenId, buckets) => Effect.promise(() => s.getDaily(tokenId, buckets)),
  putDaily: (tokenId, prices) => Effect.promise(() => s.putDaily(tokenId, prices)),
  getDailyByRef: (ref, buckets) => Effect.promise(() => s.getDailyByRef(ref, buckets)),
  putDailyByRef: (ref, prices) => Effect.promise(() => s.putDailyByRef(ref, prices)),
});

export const cacheStorePort = (s: ReturnType<typeof createUserCacheStore>): CacheStore => ({
  get: (key) =>
    Effect.map(
      Effect.promise(() => s.get(key)),
      Option.fromNullable,
    ),
  getMany: (keys) => Effect.promise(() => s.getMany(keys)),
  put: (key, value, ttlMs) => Effect.promise(() => s.put(key, value, ttlMs)),
  putMany: (writes) => Effect.promise(() => s.putMany(writes)),
});

export const refIndexStorePort = (
  s: ReturnType<typeof createGlobalTokenRefIndexStore>,
): GlobalTokenRefIndexStore => ({
  lookup: (upstream, chainRefs) => Effect.promise(() => s.lookup(upstream, chainRefs)),
  putAll: (rows, updatedAt) => Effect.promise(() => s.putAll(rows, updatedAt)),
  refreshedAt: (upstream) =>
    Effect.map(
      Effect.promise(() => s.refreshedAt(upstream)),
      Option.fromNullable,
    ),
});
