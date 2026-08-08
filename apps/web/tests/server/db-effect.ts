import { env } from "cloudflare:test";
import { type Database, databaseLayer } from "@folio/db";
import type { Context } from "effect";
import { Effect, type Layer } from "effect";

// **workers 池里的测试要直接摸 D1 那四个 store 时用这个。**
//
// 三个词各指一样东西,别混:
//   · `port`    —— 端口的 **Tag**(要哪个 store:`CacheStore` / `TokenStore` / …)
//   · `layer`   —— 那个端口的 D1 实现(`userCacheStoreLayer({ userId })` 这种,自己还差一个
//                  `Database` 才建得起来)
//   · `use(…)`  —— 拿到的是建好的**服务**本身,方法直接调
//
// 这里只补最后一环:`databaseLayer(env)`,底下是真 D1(Miniflare)。
// (`runRequest` 那条是给**被测代码**用的;夹具要的是「往库里塞一行」,不必经参考层。)
export const withStore = <I, S, A>(
  port: Context.Tag<I, S>,
  layer: Layer.Layer<I, never, Database>,
  use: (service: S) => Effect.Effect<A>,
): Promise<A> => runWith(layer, Effect.flatMap(port, use));

// 被测代码本身就是个还没接依赖的 effect(`manualBalancesForWarm(accounts)` 那种)时用这个:
// 只补它缺的那层 store + 真 D1,然后在测试的边缘跑一次。
export const runWith = <I, A>(
  layer: Layer.Layer<I, never, Database>,
  effect: Effect.Effect<A, never, I>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(databaseLayer(env))));
