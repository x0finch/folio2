import { Duration, Effect, Fiber, Option, Schedule, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { defineRateLimit, type RateLimitOptions } from "../src/ratelimit";
import { MemorySlotStore } from "../src/slot-store";

// 时序断言全部走 `TestClock` —— **不断言墙钟**(CODING.md)。迁移前那版得注入假 `sleep` 并数
// 「睡了几次、睡了多久」;这里直接推进时间看放行了几发,断言的是行为不是实现。
//
// **每个断言都重建一次闸。** 游标是闸自己的状态,「差一毫秒还没放行 / 到点放行」这种成对断言
// 若共用一个闸,第一次就把游标推到未来了,第二次要等的其实更久。

// 起一个 fiber 跑 task,推进 ms 毫秒,回「已经跑完了吗」。
// **`ms` 为 0 也要 adjust** —— 它顺带把调度让出去,不然刚 fork 的 fiber 一步都没跑过,poll 必然是
// None,「立刻放行」那几条就永远断言失败。
const settledAfter = <A>(task: Effect.Effect<A>, ms: number): Promise<boolean> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(task);
    yield* TestClock.adjust(Duration.millis(ms));
    return Option.isSome(yield* Fiber.poll(fiber));
  }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);

const gateOf = (over: Partial<RateLimitOptions> = {}) =>
  defineRateLimit({ key: "k", limit: 1, interval: 125, store: new MemorySlotStore(), ...over });

// n 发并发过同一个新建的闸。
const nRequests = (n: number, over: Partial<RateLimitOptions> = {}) => {
  const gate = gateOf(over);
  return Effect.all(Array.from({ length: n }, (_, i) => gate(Effect.succeed(i))));
};

describe("defineRateLimit", () => {
  it("头一发立刻放行", async () => {
    expect(await settledAfter(nRequests(1), 0)).toBe(true);
  });

  it("limit=1 时第二发要等一个间距", async () => {
    expect(await settledAfter(nRequests(2), 124)).toBe(false);
    expect(await settledAfter(nRequests(2), 125)).toBe(true);
  });

  it("突发额度 = (limit-1) 个间距,头 limit 发都不等", async () => {
    // 间距 200ms,突发 800ms。
    expect(await settledAfter(nRequests(5, { limit: 5, interval: 1000 }), 0)).toBe(true);
  });

  it("第 limit+1 发落在下一个间距上", async () => {
    const over = { limit: 5, interval: 1000 };
    expect(await settledAfter(nRequests(6, over), 199)).toBe(false);
    expect(await settledAfter(nRequests(6, over), 200)).toBe(true);
  });

  it("闲置过后突发额度自动补满(不惩罚闲置)", async () => {
    const gate = gateOf({ limit: 2, interval: 100 });
    const program = Effect.gen(function* () {
      yield* Effect.all([gate(Effect.void), gate(Effect.void)]); // 花掉突发
      yield* TestClock.adjust(Duration.millis(10_000)); // 闲很久
      // 补满了 → 又能连发两个不等。若被惩罚,这里会挂住、下面的 runPromise 永不 resolve。
      yield* Effect.all([gate(Effect.void), gate(Effect.void)]);
      return "done";
    });
    const out = await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)));
    expect(out).toBe("done");
  });

  it("forKey 分队:不同子键各有一份额度", async () => {
    const gate = gateOf();
    // 同一档配额、两个子键 —— 两发都该立刻放行(各自的队里只有自己)。
    const both = Effect.all([
      gate.forKey("a")(Effect.succeed(1)),
      gate.forKey("b")(Effect.succeed(2)),
    ]);
    expect(await settledAfter(both, 0)).toBe(true);
  });

  it("同一子键仍然排队", async () => {
    const sameKey = () => {
      const gate = gateOf();
      return Effect.all([gate.forKey("a")(Effect.succeed(1)), gate.forKey("a")(Effect.succeed(2))]);
    };
    expect(await settledAfter(sameKey(), 124)).toBe(false);
    expect(await settledAfter(sameKey(), 125)).toBe(true);
  });

  it("重试加在闸外面时,每次重试都重新排队", async () => {
    // 这是相对迁移前的**语义变化点**:老版把 retry 收进 http 包里,靠包自己保证「闸在重试内层」;
    // 现在重试由调用方 `Effect.retry` 加在外面,而它重跑的是整个 effect(闸也在里面)——
    // 所以每次重试自然重新过闸。这条钉住,免得以后有人把闸挪到重试外面去。
    const flakyThrice = () => {
      const gate = gateOf();
      let attempts = 0;
      const task = gate(
        Effect.suspend(() => {
          attempts++;
          return attempts < 3 ? Effect.fail("boom" as const) : Effect.succeed("ok");
        }),
      );
      return Effect.orDie(Effect.retry(task, Schedule.recurs(5)));
    };
    // 三次尝试 = 第 2、3 发各等一个间距(125ms)。差一毫秒就还没成。
    expect(await settledAfter(flakyThrice(), 249)).toBe(false);
    expect(await settledAfter(flakyThrice(), 250)).toBe(true);
  });

  it("配置非法当场抛(限频器建不出来比静默不限频好)", () => {
    expect(() => gateOf({ limit: 0 })).toThrow(/limit/);
    expect(() => gateOf({ limit: 1.5 })).toThrow(/limit/);
    expect(() => gateOf({ interval: 0 })).toThrow(/interval/);
    expect(() => gateOf({ interval: Number.POSITIVE_INFINITY })).toThrow(/interval/);
  });
});
