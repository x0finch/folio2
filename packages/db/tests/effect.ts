import { env } from "cloudflare:test";
import { Effect, Layer, TestClock, TestContext } from "effect";
import { type DbClient, dbClientLayer } from "../src/client";
import { CurrentUser } from "../src/current-user";
import { Database, DatabaseForOracle, GlobalDatabase } from "../src/database";

// 这几个 store 的测试共用的装配(#362 第 5 站)。**跑的是生产那条路**:layer → Tag,
// 底下是真 D1(Miniflare),只有时钟是假的。
//
// 时钟为什么要假:store 的 TTL / stale 判定走 `Clock`(以前是 `opts.now` 一个只有测试会传的
// 字段),而这些用例要断言「过期戳恰好是 now + ttl」这种精确值 —— 赌墙钟就成了 flaky
// (CODING.md「别断言墙上时钟」)。
export const NOW = 1000;

// 跑一个只依赖 `DbClient` 的 effect —— 下面两个把手底下都是它。
// **不出文件**:用例经 `forDomain` / `forGlobal` 取服务,没有第二条构造路。
const runDb = <A>(effect: Effect.Effect<A, never, DbClient>, nowMs = NOW): Promise<A> =>
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

// 一个领域的把手(ADR 0037 / 0044):`forDomain((db) => db.tabPins)` 之后
// `tabPins(USER_A).create(…)`。layer 不按用户各建一份 —— 一份 `Database.Default`,userId 由
// `CurrentUser` 在建服务那一刻给进去。
//
// 用例**只经聚合 `Database` 拿服务**(#504 T5),不再 provide 某个领域自己的 layer 再 yield 它的
// Tag:那排 Tag 是过渡形状,测试盯着它就等于给退场排一次返工。断言侧看不出区别 —— 这正是
// 「挂进聚合」这件事要保住的性质。
//
// 测试**保持 Promise 形状**是有判据的(CODING.md / #391):这些用例测的是「数据落库对不对」——
// 真 D1、主键冲突、跨用户隔离,跟时序无关。测编排行为的那种才翻 Effect + TestClock。
export const forDomain =
  <S extends object>(pick: (db: Database) => S) =>
  (userId: string, nowMs = NOW): Promisified<S> =>
    promisifiedFrom(
      Effect.provide(Effect.map(Database, pick), asUser(Database.Default, userId)),
      nowMs,
    );

// `GlobalDatabase` 的把手 —— 与 `forDomain` 同款,少一个 userId 参数,因为那张门票上的 op
// 本来就没有「谁的」这回事(全局映射表 / cron 扫用户)。**它拿不到 `CurrentUser`,这不是省事**:
// 那正是这一半在类型上与 per-user 那半的全部区别。
export const forGlobal =
  <S extends object>(pick: (db: GlobalDatabase) => S) =>
  (nowMs = NOW): Promisified<S> =>
    promisifiedFrom(
      Effect.provide(Effect.map(GlobalDatabase, pick), GlobalDatabase.Default),
      nowMs,
    );

// 参考层那张门票的把手。`namer` 是它的构造参数(db 层不预设厂商,#199),所以这里也得给 ——
// 多数用例用默认的那个,只有测「按命名者点查」的才换。
export const forOracle =
  <S extends object>(pick: (db: DatabaseForOracle) => S) =>
  (userId: string, namer: string, nowMs = NOW): Promisified<S> =>
    promisifiedFrom(
      Effect.provide(
        Effect.map(DatabaseForOracle, pick),
        asUser(DatabaseForOracle.Default(namer), userId),
      ),
      nowMs,
    );

// 「这一层按谁跑」—— 把 `CurrentUser` 喂进去,剩下的只差 `DbClient`(由 `runDb` provide)。
const asUser = <I>(
  layer: Layer.Layer<I, never, DbClient | CurrentUser>,
  userId: string,
): Layer.Layer<I, never, DbClient> =>
  Layer.provide(layer, Layer.merge(Layer.succeed(CurrentUser, userId), Layer.context<DbClient>()));

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
