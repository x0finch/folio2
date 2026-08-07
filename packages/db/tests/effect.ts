import { env } from "cloudflare:test";
import type { Context } from "effect";
import { Effect, type Layer, TestClock, TestContext } from "effect";
import { type Database, databaseLayer } from "../src/database";

// 这几个 store 的测试共用的装配(#362 第 5 站)。**跑的是生产那条路**:layer → Tag,
// 底下是真 D1(Miniflare),只有时钟是假的。
//
// 时钟为什么要假:store 的 TTL / stale 判定走 `Clock`(以前是 `opts.now` 一个只有测试会传的
// 字段),而这些用例要断言「过期戳恰好是 now + ttl」这种精确值 —— 赌墙钟就成了 flaky
// (CODING.md「别断言墙上时钟」)。
export const NOW = 1000;

const runDb = <A>(effect: Effect.Effect<A, never, Database>, nowMs = NOW): Promise<A> =>
  Effect.runPromise(
    Effect.zipRight(TestClock.setTime(nowMs), effect).pipe(
      Effect.provide(databaseLayer(env)),
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

export const promisified = <I, S extends object>(
  tag: Context.Tag<I, S>,
  layer: Layer.Layer<I, never, Database>,
  nowMs = NOW,
): Promisified<S> =>
  new Proxy({} as Promisified<S>, {
    get:
      (_target, key) =>
      (...args: unknown[]) =>
        runDb(
          Effect.flatMap(tag, (service) => {
            const method = (service as Record<string | symbol, unknown>)[key];
            if (typeof method !== "function") {
              throw new TypeError(`not a method on the service: ${String(key)}`);
            }
            return (method as (...a: unknown[]) => Effect.Effect<unknown>).apply(service, args);
          }).pipe(Effect.provide(layer)),
          nowMs,
        ),
  });
