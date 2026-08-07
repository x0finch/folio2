import { env } from "cloudflare:test";
import { databaseLayer } from "@folio/db";
import type { Context } from "effect";
import { Effect, type Layer } from "effect";

// **workers 池里的测试要直接摸 D1 那几个 store 时用这个。**
//
// #362 第 5 站起 db 的四个参考层 store 是 Effect 服务(layer → Tag),所以夹具不再
// `createUserTokenStore(env, …).put(…)` 那样直接调 —— 走同一条 layer,底下是真 D1。
// (`runOracle` 那条是给**被测代码**用的;夹具要的是「往库里塞一行」,不必经参考层。)
export const withDbService = <I, S, A>(
  tag: Context.Tag<I, S>,
  layer: Layer.Layer<I, never, import("@folio/db").Database>,
  use: (service: S) => Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(tag, use).pipe(Effect.provide(layer), Effect.provide(databaseLayer(env))),
  );
