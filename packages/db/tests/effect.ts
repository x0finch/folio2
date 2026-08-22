import { env } from "cloudflare:test";
import type { Context } from "effect";
import { Effect, type Layer, TestClock, TestContext } from "effect";
import { Database } from "../src/database";
import { type DbClient, dbClientLayer } from "../src/stores/service";

// 这几个 store 的测试共用的装配(#362 第 5 站)。**跑的是生产那条路**:layer → Tag,
// 底下是真 D1(Miniflare),只有时钟是假的。
//
// 时钟为什么要假:store 的 TTL / stale 判定走 `Clock`(以前是 `opts.now` 一个只有测试会传的
// 字段),而这些用例要断言「过期戳恰好是 now + ttl」这种精确值 —— 赌墙钟就成了 flaky
// (CODING.md「别断言墙上时钟」)。
export const NOW = 1000;

// 跑一个只依赖 `DbClient` 的 effect(不带 userId 的系统级查询用,如 `listUserIdsWithAccounts`)。
export const runDb = <A>(effect: Effect.Effect<A, never, DbClient>, nowMs = NOW): Promise<A> =>
  Effect.runPromise(
    Effect.zipRight(TestClock.setTime(nowMs), effect).pipe(
      Effect.provide(dbClientLayer(env)),
      Effect.provide(TestContext.TestContext),
    ),
  );

// 一个服务的 **Promise 把手**:`store.create(…)` 这样直接 await,而不必每句都写
// `runDb(Effect.flatMap(Tag, (s) => s.create(…)))`。
//
// 它只是测试的便利,不是第二条构造路 —— 每次调用底下都是 provide 同一个 layer 再 `runPromise`,
// 而这些用例本来就是「一次调用 = 一次独立的 D1 操作」那种粒度。
type Promisified<S> = {
  [K in keyof S]: S[K] extends (...args: infer A) => Effect.Effect<infer R, infer _E, infer _R>
    ? (...args: A) => Promise<R>
    : S[K];
};

// per-user 服务的把手(#394 ADR 0037):userId 现在由 layer 吃掉,所以每个用户各建一份。
// 用法:`const accounts = forUser(AccountStore, AccountStore.Default)` 之后 `accounts(USER_A).create(…)`。
//
// 测试**保持 Promise 形状**是有判据的(CODING.md / #391):这些用例测的是「数据落库对不对」——
// 真 D1、主键冲突、跨用户隔离,跟时序无关。测编排行为的那种才翻 Effect + TestClock。
export const forUser =
  <I, S extends object>(
    tag: Context.Tag<I, S>,
    layerOf: (userId: string) => Layer.Layer<I, never, DbClient>,
  ) =>
  (userId: string, nowMs = NOW): Promisified<S> =>
    promisified(tag, layerOf(userId), nowMs);

// 已经挂进聚合 `Database` 的领域用这个:`forDomain((db) => db.tabPins)`。
// 与 `forUser` 的唯一差别是**怎么拿到服务** —— 那边是「provide 领域自己的 layer 再 yield 它的 Tag」,
// 这边是「provide 聚合的 layer 再取那个字段」。断言侧看不出区别,这正是搬家要保住的性质。
export const forDomain =
  <S extends object>(pick: (db: Context.Tag.Service<Database>) => S) =>
  (userId: string, nowMs = NOW): Promisified<S> =>
    promisifiedFrom(Effect.provide(Effect.map(Database, pick), Database.layer(userId)), nowMs);

export const promisified = <I, S extends object>(
  tag: Context.Tag<I, S>,
  layer: Layer.Layer<I, never, DbClient>,
  nowMs = NOW,
): Promisified<S> => promisifiedFrom(Effect.provide(tag, layer), nowMs);

// 「怎么拿到这个服务」是一个 effect(只差一个 `DbClient`),把手只管把它的方法一个个跑成 Promise。
const promisifiedFrom = <S extends object>(
  service: Effect.Effect<S, never, DbClient>,
  nowMs = NOW,
): Promisified<S> =>
  new Proxy({} as Promisified<S>, {
    get:
      (_target, key) =>
      (...args: unknown[]) =>
        runDb(
          Effect.flatMap(service, (resolved) => {
            const method = (resolved as Record<string | symbol, unknown>)[key];
            if (typeof method !== "function") {
              throw new TypeError(`not a method on the service: ${String(key)}`);
            }
            return (method as (...a: unknown[]) => Effect.Effect<unknown>).apply(resolved, args);
          }),
          nowMs,
        ),
  });
