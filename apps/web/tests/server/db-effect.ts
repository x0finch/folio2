import { env } from "cloudflare:test";
import {
  AccountStore,
  type DbClient,
  dbClientLayer,
  ManualStore,
  PortfolioStore,
  SettingsStore,
  SnapshotStore,
  TagStore,
  TransferStore,
} from "@folio/db";
import type { Context } from "effect";
import { Effect, Layer } from "effect";

// **workers 池里的测试要直接摸 D1 那些 store 时用这个。**
//
// 三个词各指一样东西,别混:
//   · `port`    —— 端口的 **Tag**(要哪个 store:`CacheStore` / `TokenStore` / …)
//   · `layer`   —— 那个端口的 D1 实现(`userCacheStoreLayer({ userId })` 这种,自己还差一个
//                  `DbClient` 才建得起来)
//   · `use(…)`  —— 拿到的是建好的**服务**本身,方法直接调
//
// 这里只补最后一环:`dbClientLayer(env)`,底下是真 D1(Miniflare)。
// (`runRequest` 那条是给**被测代码**用的;夹具要的是「往库里塞一行」,不必经参考层。)
export const withStore = <I, S, A>(
  port: Context.Tag<I, S>,
  layer: Layer.Layer<I, never, DbClient>,
  use: (service: S) => Effect.Effect<A>,
): Promise<A> => runWith(layer, Effect.flatMap(port, use));

const runWith = <I, A>(
  layer: Layer.Layer<I, never, DbClient>,
  effect: Effect.Effect<A, never, I>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(dbClientLayer(env))));

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

const promisified = <I, S extends object>(
  tag: Context.Tag<I, S>,
  layer: Layer.Layer<I, never, DbClient>,
): Promisified<S> =>
  new Proxy({} as Promisified<S>, {
    get:
      (_target, key) =>
      (...args: unknown[]) =>
        runWith(
          layer,
          Effect.flatMap(tag, (service) => {
            const method = (service as Record<string | symbol, unknown>)[key];
            if (typeof method !== "function") {
              throw new TypeError(`not a method on the service: ${String(key)}`);
            }
            return (method as (...a: unknown[]) => Effect.Effect<unknown>).apply(service, args);
          }),
        ),
  });

/** 一个用户的全部 store 把手:`dbFor(USER).accounts.list()`。 */
export const dbFor = (userId: string) => ({
  accounts: promisified(AccountStore, AccountStore.Default(userId)),
  portfolios: promisified(PortfolioStore, PortfolioStore.Default(userId)),
  settings: promisified(SettingsStore, SettingsStore.Default(userId)),
  snapshots: promisified(SnapshotStore, SnapshotStore.Default(userId)),
  manual: promisified(ManualStore, ManualStore.Default(userId)),
  tags: promisified(TagStore, TagStore.Default(userId)),
  // 导入那三个写口要另外两个 store(见 `TransferStore.Default` 的依赖声明)。
  transfer: promisified(
    TransferStore,
    Layer.provide(
      TransferStore.Default(userId),
      Layer.merge(SnapshotStore.Default(userId), ManualStore.Default(userId)),
    ),
  ),
});
