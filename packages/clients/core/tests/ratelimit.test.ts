import {
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  type RateLimiter,
  Schedule,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import { make, type RateLimitOptions } from "../src/ratelimit";
import { SLOT_URL_PREFIX, type SlotCache, SlotCacheOverride } from "../src/slot-cursor";

// 时序断言全部走 `TestClock` —— **不断言墙钟**(CODING.md)。
//
// **两档分开测,因为它们是两个实现**:`memory` 是 Effect 官方的 token-bucket(我们只验「确实委托
// 过去了」,官方算法不重复验);`isolated` 是本包为跨 isolate 写的 GCRA,那才是要细测的。
//
// `isolated` 的游标按 key 存在模块级(刻意的,见 slot-cursor.ts),所以**每个 case 用不同的 key**
// 来隔离 —— 不提供 reset 开关。

let seq = 0;
const freshKey = () => `test:${seq++}`;

// 起一个 fiber 跑 task,推进 ms 毫秒,回「已经跑完了吗」。
// **`ms` 为 0 也要 adjust** —— 它顺带把调度让出去,不然刚 fork 的 fiber 一步都没跑过,poll 必然是
// None,「立刻放行」那几条就永远断言失败。
const settledAfter = (
  options: Omit<RateLimitOptions, "key"> & { key?: string },
  ms: number,
  use: (gate: RateLimiter.RateLimiter) => Effect.Effect<unknown>,
  cache?: SlotCache,
): Promise<boolean> =>
  Effect.gen(function* () {
    const gate = yield* make({ key: options.key ?? freshKey(), ...options });
    const fiber = yield* Effect.fork(use(gate));
    yield* TestClock.adjust(Duration.millis(ms));
    return Option.isSome(yield* Fiber.poll(fiber));
  }).pipe(
    Effect.scoped,
    cache ? Effect.provide(Layer.succeed(SlotCacheOverride, cache)) : (e) => e,
    Effect.provide(TestContext.TestContext),
    Effect.runPromise,
  );

const nTimes = (n: number) => (gate: RateLimiter.RateLimiter) =>
  Effect.all(Array.from({ length: n }, (_, i) => gate(Effect.succeed(i))));

describe("scope: memory —— 委托给官方实现", () => {
  it("前 limit 发满额突发", async () => {
    expect(await settledAfter({ limit: 5, interval: "1 seconds" }, 0, nTimes(5))).toBe(true);
  });

  it("第 limit+1 发等一个令牌(官方 token-bucket:interval/limit)", async () => {
    const opts = { limit: 5, interval: "1 seconds" } as const;
    expect(await settledAfter(opts, 199, nTimes(6))).toBe(false);
    expect(await settledAfter(opts, 200, nTimes(6))).toBe(true);
  });

  it("桶绑在 scope 上 —— 每次 make 一份,天然隔离(同 key 也不串)", async () => {
    const opts = { key: "fixed", limit: 1, interval: "1 seconds" } as const;
    // 同一个 key 连做两次,第二次仍是满额:memory 档不跨 make 共享。
    expect(await settledAfter(opts, 0, nTimes(1))).toBe(true);
    expect(await settledAfter(opts, 0, nTimes(1))).toBe(true);
  });
});

describe("scope: isolated —— GCRA 时隙游标", () => {
  const iso = (over: Partial<RateLimitOptions> = {}) =>
    ({ limit: 1, interval: "125 millis", scope: "isolated", ...over }) as const;

  it("头一发立刻放行", async () => {
    expect(await settledAfter(iso(), 0, nTimes(1))).toBe(true);
  });

  it("limit=1 时第二发等一个间距", async () => {
    expect(await settledAfter(iso(), 124, nTimes(2))).toBe(false);
    expect(await settledAfter(iso(), 125, nTimes(2))).toBe(true);
  });

  it("突发额度 = (limit-1) 个间距", async () => {
    const o = iso({ limit: 5, interval: "1 seconds" });
    expect(await settledAfter(o, 0, nTimes(5))).toBe(true);
    expect(await settledAfter(iso({ limit: 5, interval: "1 seconds" }), 199, nTimes(6))).toBe(
      false,
    );
    expect(await settledAfter(iso({ limit: 5, interval: "1 seconds" }), 200, nTimes(6))).toBe(true);
  });

  it("游标跨 make 调用共享(同 key)—— 这正是 memory 档做不到的那件事", async () => {
    const key = freshKey();
    const o = iso({ key });
    // 第一次 make 花掉这一发,第二次 make 拿到的是被推过的游标 → 要等。
    expect(await settledAfter(o, 0, nTimes(1))).toBe(true); // 时隙 0,游标推到 125
    expect(await settledAfter(o, 0, nTimes(1))).toBe(false); // 时隙 125,要等;游标推到 250
    expect(await settledAfter(o, 250, nTimes(1))).toBe(true); // 时隙 250
  });

  it("不同 key 各有一份额度", async () => {
    expect(await settledAfter(iso(), 0, nTimes(1))).toBe(true);
    expect(await settledAfter(iso(), 0, nTimes(1))).toBe(true); // 新 key
  });

  it("闲置过后突发额度自动补满(不惩罚闲置)", async () => {
    const key = freshKey();
    const o = iso({ key, limit: 2, interval: "100 millis" });
    expect(await settledAfter(o, 0, nTimes(2))).toBe(true); // 花掉突发
    expect(await settledAfter(o, 10_000, nTimes(2))).toBe(true); // 闲很久后又能连发
  });

  it("重试加在闸外面时,每次重试都重新排队", async () => {
    // 相对迁移前的**语义变化点**:老版把 retry 收进 http 包、靠包自己保证「闸在重试内层」;
    // 现在重试由调用方加在外面,而 `Effect.retry` 重跑的是整个 effect(闸在里面)—— 自动成立。
    const flaky = () => {
      let n = 0;
      return (gate: RateLimiter.RateLimiter) =>
        Effect.orDie(
          Effect.retry(
            gate(
              Effect.suspend(() => (++n < 3 ? Effect.fail("boom" as const) : Effect.succeed(n))),
            ),
            Schedule.recurs(5),
          ),
        );
    };
    // 三次尝试 = 第 2、3 发各等一个间距。
    expect(await settledAfter(iso({ key: freshKey() }), 249, flaky())).toBe(false);
    expect(await settledAfter(iso({ key: freshKey() }), 250, flaky())).toBe(true);
  });
});

describe("scope: isolated —— 跨 isolate 共享游标", () => {
  // 假 Cache API:一个 Map。用 `SlotCacheOverride` 注入 —— 它是**可选服务**(`Effect.serviceOption`
  // 读),所以不 provide 时 `R` 通道也是干净的,生产回退到 `globalThis.caches`。
  const fakeCache = (seed?: { key: string; slotAt: number }) => {
    const store = new Map<string, string>();
    if (seed) store.set(SLOT_URL_PREFIX + encodeURIComponent(seed.key), String(seed.slotAt));
    const cache: SlotCache = {
      match: async (u) => (store.has(u) ? new Response(store.get(u)) : undefined),
      put: async (u, r) => {
        store.set(u, await r.text());
      },
    };
    return { cache, store };
  };

  it("冷启时读回别人的进度 —— 新 isolate 不再开局满额突发", async () => {
    const key = freshKey();
    // 别的 isolate 已经把游标推到 5 秒后。TestClock 从 0 起 → 本 isolate 该等到那时候。
    const { cache } = fakeCache({ key, slotAt: 5000 });
    const o = { limit: 1, interval: "125 millis", scope: "isolated", key } as const;
    expect(await settledAfter(o, 4999, nTimes(1), cache)).toBe(false);

    const again = fakeCache({ key: `${key}-b`, slotAt: 5000 });
    const o2 = { ...o, key: `${key}-b` } as const;
    expect(await settledAfter(o2, 5000, nTimes(1), again.cache)).toBe(true);
  });

  it("抢完把新游标播出去", async () => {
    const key = freshKey();
    const { cache, store } = fakeCache();
    await settledAfter(
      { limit: 1, interval: "125 millis", scope: "isolated", key },
      0,
      nTimes(1),
      cache,
    );
    const written = store.get(SLOT_URL_PREFIX + encodeURIComponent(key));
    expect(Number(written)).toBe(125); // tat(0) + 一个间距
  });

  it("缓存读写炸了不影响放行 —— 限速器不该是新的故障源", async () => {
    const broken: SlotCache = {
      match: () => Promise.reject(new Error("cache down")),
      put: () => Promise.reject(new Error("cache down")),
    };
    const o = { limit: 1, interval: "125 millis", scope: "isolated", key: freshKey() } as const;
    expect(await settledAfter(o, 0, nTimes(1), broken)).toBe(true);
  });
});
