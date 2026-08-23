import { env } from "cloudflare:test";
import {
  CurrentUser,
  Database,
  DatabaseForOracle,
  type DbClient,
  dbClientLayer,
  GlobalDatabase,
} from "@folio/db";
import { UPSTREAM_ID } from "@folio/oracle-upstream-coingecko";
import { Effect, Layer } from "effect";

// **workers 池里的测试要往 D1 里塞行 / 读回来看看时用这几个把手。**
//
// 底下补的是两环:`dbClientLayer(env)`(真 D1,Miniflare)与 `CurrentUser`(ADR 0044)。
// (`runForUser` 那条是给**被测代码**用的;夹具要的是「往库里塞一行」,不必经参考层。)
//
// 以前这里还有一个 `withStore(port, layer, userId, use)` —— 参考层那几个端口的通用取法。
// 端口没了(契约就是 db 里的实现),取法也就统一成了下面这三个门票把手。

const runWith = <I, A>(
  layer: Layer.Layer<I, never, DbClient | CurrentUser>,
  userId: string,
  effect: Effect.Effect<A, never, I | Database | DbClient | CurrentUser>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layer),
      Effect.provide(Database.Default),
      Effect.provide(dbClientLayer(env)),
      Effect.provideService(CurrentUser, userId),
    ),
  );

// —— 夹具用的 per-user 把手(#394 T8)——
//
// `createDb(env)` 那层过渡门面删掉之后,夹具「往库里塞一行 / 读回来看看」也没有 Promise 出口了。
// 这里补上,形状与 `packages/db/tests/effect.ts` 的 `promisified` 一样、理由也一样:
// **这些用例测的是数据落库对不对**,与时序无关,保持 Promise 形状读起来最直白。
//
// 它是**夹具**,不是第二条生产路 —— 每个方法底下都是 provide 同一个 layer 再 `runPromise`,
// 而夹具本来就是「一次调用 = 一次独立的 D1 操作」那种粒度。
type Promisified<S> = {
  [K in keyof S]: S[K] extends (...args: infer A) => Effect.Effect<infer R, infer _E, infer _R>
    ? (...args: A) => Promise<R>
    : S[K];
};

// 「怎么拿到这个服务」与「怎么跑」分开传:per-user 那半跑 `runWith`(要 userId),
// 全局那半跑 `runGlobal`(没有 userId 可给 —— 见下)。
const promisifiedFrom = <S extends object, R>(
  service: Effect.Effect<S, never, R>,
  run: <A>(effect: Effect.Effect<A, never, R>) => Promise<A>,
): Promisified<S> =>
  new Proxy({} as Promisified<S>, {
    get:
      (_target, key) =>
      (...args: unknown[]) =>
        run(
          Effect.flatMap(service, (resolved) => {
            const method = (resolved as Record<string | symbol, unknown>)[key];
            if (typeof method !== "function") {
              throw new TypeError(`not a method on the service: ${String(key)}`);
            }
            return (method as (...a: unknown[]) => Effect.Effect<unknown>).apply(resolved, args);
          }),
        ),
  });

/**
 * 一个用户的全部 store 把手:`dbFor(USER).accounts.list()`。
 *
 * **只经聚合 `Database` 拿服务**(#504 T13:那排旧域 Tag 已经删了)。原来这里是七行
 * `promisified(XxxStore, XxxStore.Default, userId)`,其中 transfer 还得手工把它依赖的另外
 * 两个 store 拼上 —— 那份接线现在住在聚合里,夹具不必再复述一遍。
 */
export const dbFor = (userId: string) => {
  const of = <S extends object>(pick: (db: Database) => S) =>
    promisifiedFrom(Effect.map(Database, pick), (effect) => runWith(Layer.empty, userId, effect));
  return {
    accounts: of((db) => db.accounts),
    portfolios: of((db) => db.portfolios),
    settings: of((db) => db.settings),
    snapshots: of((db) => db.snapshots),
    manual: of((db) => db.manual),
    tags: of((db) => db.tags),
    tabPins: of((db) => db.tabPins),
    transfer: of((db) => db.transfer),
    cache: of((db) => db.cache),
  };
};

/**
 * 参考层那张门票的夹具把手:`oracleDbFor(USER).tokens.create(…)`。
 *
 * 夹具要往代币行 / 价格行里塞数据(生产路径是 mint,那些用例不测认币),而这几片**故意不在**
 * `Database` 上 —— handler 拿不到它们(#504 T17)。夹具经这张票拿,和参考层自己走同一条路。
 *
 * `namer` 用当前上游那个常量:db 层不预设厂商(#199),而这些夹具种的就是「当前上游认出来的
 * 那条 ref」。
 */
export const oracleDbFor = (userId: string) => {
  const of = <S extends object>(pick: (db: DatabaseForOracle) => S) =>
    promisifiedFrom(
      Effect.provide(
        Effect.map(DatabaseForOracle, pick),
        Layer.provide(DatabaseForOracle.Default(UPSTREAM_ID), Layer.succeed(CurrentUser, userId)),
      ),
      (effect) => runWith(Layer.empty, userId, effect),
    );
  return {
    tokens: of((db) => db.tokens),
    tokenPrices: of((db) => db.tokenPrices),
  };
};

// 跑一个只要 `GlobalDatabase` 的 effect。**这里没有 `CurrentUser` 可 provide** —— 那张门票上的
// op 本来就没有「谁的」这回事,而这正是它与上面那半在类型上的全部区别。
const runGlobal = <A>(effect: Effect.Effect<A, never, GlobalDatabase>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(GlobalDatabase.Default), Effect.provide(dbClientLayer(env))),
  );

/**
 * 不带 userId 的那张门票的夹具把手:`globalDb.refIndex.putAll(…)`。
 *
 * 以前这里写的是 `withStore(GlobalTokenRefIndexStore, globalTokenRefIndexStoreLayer, USER, …)`
 * —— 那个 `USER` 是喂给 `runWith` 的占位,全局表根本不看它。占位没了,是因为那条路上
 * 现在真的没有用户这个概念。
 */
export const globalDb = {
  refIndex: promisifiedFrom(
    Effect.map(GlobalDatabase, (db) => db.refIndex),
    runGlobal,
  ),
  accounts: promisifiedFrom(
    Effect.map(GlobalDatabase, (db) => db.accounts),
    runGlobal,
  ),
};
