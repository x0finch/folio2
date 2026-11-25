import { Clock, Duration, Effect, Fiber, Layer, Schedule } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  make,
  type RateLimit,
  type RateLimitOptions,
  RateLimitScopeOverride,
  setScopeDefaultForTests,
} from "../../src/runtime/ratelimit";
import { SLOT_URL_PREFIX, type SlotCache, SlotCacheOverride } from "../../src/runtime/slot-cursor";

// Timing asserts run on TestClock, never the wall clock. Both scopes run our GCRA; `memory` keeps
// its cursor private to the gate, `isolated` shares it by key. Its cursors are module-level per key, so each
// case uses a distinct key.

let seq = 0;
const freshKey = () => `test:${seq++}`;

// Forks the task, advances `ms`, reports whether it finished. Adjust even for 0 ms: it yields,
// otherwise the fresh fiber never runs and the poll is always None.
const settledAfter = (
  options: Omit<RateLimitOptions, "key"> & { key?: string },
  ms: number,
  use: (gate: RateLimit) => Effect.Effect<unknown>,
  cache?: SlotCache,
): Promise<boolean> =>
  Effect.gen(function* () {
    const gate = yield* make({ key: options.key ?? freshKey(), ...options });
    const fiber = yield* Effect.forkChild(use(gate));
    yield* TestClock.adjust(Duration.millis(ms));
    return (yield* Effect.sync(() => fiber.pollUnsafe())) !== undefined;
  }).pipe(
    Effect.scoped,
    cache ? Effect.provide(Layer.succeed(SlotCacheOverride, cache)) : (e) => e,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );

const nTimes = (n: number) => (gate: RateLimit) =>
  Effect.all(Array.from({ length: n }, (_, i) => gate(Effect.succeed(i))));

describe("scope: memory — GCRA on a private cursor", () => {
  // Explicit scope: the default is `isolated`, whose cursor is shared across `make` calls.
  it("first `limit` requests burst at full quota", async () => {
    expect(
      await settledAfter({ limit: 5, interval: "1 seconds", scope: "memory" }, 0, nTimes(5)),
    ).toBe(true);
  });

  it("request limit+1 waits one spacing (interval/limit)", async () => {
    const opts = { limit: 5, interval: "1 seconds", scope: "memory" } as const;
    expect(await settledAfter(opts, 199, nTimes(6))).toBe(false);
    expect(await settledAfter(opts, 200, nTimes(6))).toBe(true);
  });

  it("bucket is bound to the scope — each make is isolated (even with the same key)", async () => {
    const opts = { key: "fixed", limit: 1, interval: "1 seconds", scope: "memory" } as const;
    expect(await settledAfter(opts, 0, nTimes(1))).toBe(true);
    expect(await settledAfter(opts, 0, nTimes(1))).toBe(true);
  });
});

describe("scope: isolated — GCRA slot cursor", () => {
  const iso = (over: Partial<RateLimitOptions> = {}) =>
    ({ limit: 1, interval: "125 millis", scope: "isolated", ...over }) as const;

  it("first request passes immediately", async () => {
    expect(await settledAfter(iso(), 0, nTimes(1))).toBe(true);
  });

  it("with limit=1 the second request waits one spacing", async () => {
    expect(await settledAfter(iso(), 124, nTimes(2))).toBe(false);
    expect(await settledAfter(iso(), 125, nTimes(2))).toBe(true);
  });

  it("burst = (limit-1) spacings", async () => {
    const o = iso({ limit: 5, interval: "1 seconds" });
    expect(await settledAfter(o, 0, nTimes(5))).toBe(true);
    expect(await settledAfter(iso({ limit: 5, interval: "1 seconds" }), 199, nTimes(6))).toBe(
      false,
    );
    expect(await settledAfter(iso({ limit: 5, interval: "1 seconds" }), 200, nTimes(6))).toBe(true);
  });

  it("cursor is shared across make calls (same key) — what memory can't do", async () => {
    const key = freshKey();
    const o = iso({ key });
    expect(await settledAfter(o, 0, nTimes(1))).toBe(true); // slot 0, cursor → 125
    expect(await settledAfter(o, 0, nTimes(1))).toBe(false); // slot 125, waits; cursor → 250
    expect(await settledAfter(o, 250, nTimes(1))).toBe(true); // slot 250
  });

  it("different keys have separate quotas", async () => {
    expect(await settledAfter(iso(), 0, nTimes(1))).toBe(true);
    expect(await settledAfter(iso(), 0, nTimes(1))).toBe(true); // new key
  });

  it("burst refills after idling (idle time is not penalized)", async () => {
    const key = freshKey();
    const o = iso({ key, limit: 2, interval: "100 millis" });
    expect(await settledAfter(o, 0, nTimes(2))).toBe(true); // spend the burst
    expect(await settledAfter(o, 10_000, nTimes(2))).toBe(true); // long idle → burst again
  });

  it("retry outside the gate re-queues every attempt", async () => {
    // `Effect.retry` reruns the whole effect, gate included.
    const flaky = () => {
      let n = 0;
      return (gate: RateLimit) =>
        Effect.orDie(
          Effect.retry(
            gate(
              Effect.suspend(() => (++n < 3 ? Effect.fail("boom" as const) : Effect.succeed(n))),
            ),
            Schedule.recurs(5),
          ),
        );
    };
    // Three attempts = attempts 2 and 3 each wait one spacing.
    expect(await settledAfter(iso({ key: freshKey() }), 249, flaky())).toBe(false);
    expect(await settledAfter(iso({ key: freshKey() }), 250, flaky())).toBe(true);
  });
});

describe("scope: isolated — cursor shared across isolates", () => {
  // Fake Cache API (a Map), injected via the optional `SlotCacheOverride`.
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

  it("cold start reads others' progress — a new isolate gets no fresh burst", async () => {
    const key = freshKey();
    // Another isolate pushed the cursor to 5s; TestClock starts at 0 → wait until then.
    const { cache } = fakeCache({ key, slotAt: 5000 });
    const o = { limit: 1, interval: "125 millis", scope: "isolated", key } as const;
    expect(await settledAfter(o, 4999, nTimes(1), cache)).toBe(false);

    const again = fakeCache({ key: `${key}-b`, slotAt: 5000 });
    const o2 = { ...o, key: `${key}-b` } as const;
    expect(await settledAfter(o2, 5000, nTimes(1), again.cache)).toBe(true);
  });

  it("publishes the new cursor after a grab", async () => {
    const key = freshKey();
    const { cache, store } = fakeCache();
    await settledAfter(
      { limit: 1, interval: "125 millis", scope: "isolated", key },
      0,
      nTimes(1),
      cache,
    );
    const written = store.get(SLOT_URL_PREFIX + encodeURIComponent(key));
    expect(Number(written)).toBe(125); // tat(0) + one spacing
  });

  it("cache read/write failures don't block — the limiter must not become a failure source", async () => {
    const broken: SlotCache = {
      match: () => Promise.reject(new Error("cache down")),
      put: () => Promise.reject(new Error("cache down")),
    };
    const o = { limit: 1, interval: "125 millis", scope: "isolated", key: freshKey() } as const;
    expect(await settledAfter(o, 0, nTimes(1), broken)).toBe(true);
  });
});

describe("scope: isolated — concurrency", () => {
  // `Effect.all` is sequential by default, so the slot-grab atomicity needs explicit concurrency.

  const stamped = (seen: number[]) => (gate: RateLimit) =>
    Effect.all(
      Array.from({ length: 5 }, () =>
        gate(Effect.flatMap(Clock.currentTimeMillis, (t) => Effect.sync(() => seen.push(t)))),
      ),
      { concurrency: "unbounded" },
    );

  it("5 concurrent fibers each get a distinct slot; spacing holds", async () => {
    const seen: number[] = [];
    const key = freshKey();
    await Effect.gen(function* () {
      const gate = yield* make({ key, limit: 1, interval: "125 millis", scope: "isolated" });
      const fiber = yield* Effect.forkChild(stamped(seen)(gate));
      yield* TestClock.adjust(Duration.millis(1000));
      yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);

    // limit=1 → 125ms spacing, no burst: 0 / 125 / 250 / 375 / 500.
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 125, 250, 375, 500]);
    // No two on the same slot (that would be a leak).
    expect(new Set(seen).size).toBe(5);
  });

  it("with a burst: the first `limit` pass together, the rest are spaced", async () => {
    const seen: number[] = [];
    const key = freshKey();
    await Effect.gen(function* () {
      const gate = yield* make({ key, limit: 3, interval: "300 millis", scope: "isolated" });
      const fiber = yield* Effect.forkChild(stamped(seen)(gate));
      yield* TestClock.adjust(Duration.millis(1000));
      yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);

    // 100ms spacing, 200ms burst → first 3 at 0, then one every 100ms.
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 0, 0, 100, 200]);
  });
});

describe("scope: isolated — concurrent cold start (new isolate syncing many accounts)", () => {
  it("seeded shared progress applies to every fiber when the first grabs are concurrent", async () => {
    // seed is async; if it isn't a barrier, early fibers grab an un-seeded cursor and leak a burst.
    const key = `${freshKey()}-cold`;
    const store = new Map<string, string>();
    // Another isolate pushed the cursor to 5s.
    store.set(SLOT_URL_PREFIX + encodeURIComponent(key), "5000");
    const cache: SlotCache = {
      match: async (u) => (store.has(u) ? new Response(store.get(u)) : undefined),
      put: async (u, r) => {
        store.set(u, await r.text());
      },
    };

    const seen: number[] = [];
    await Effect.gen(function* () {
      const gate = yield* make({ key, limit: 1, interval: "125 millis", scope: "isolated" });
      const fiber = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 5 }, () =>
            gate(Effect.flatMap(Clock.currentTimeMillis, (t) => Effect.sync(() => seen.push(t)))),
          ),
          { concurrency: "unbounded" },
        ),
      );
      // The fake cache answers on real promises: let every fiber finish seeding and register its
      // sleep before the clock moves, or sleeps land after the jump and never fire.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      yield* TestClock.adjust(Duration.millis(10_000));
      yield* Fiber.join(fiber);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.succeed(SlotCacheOverride, cache)),
      Effect.provide(TestClock.layer()),
      Effect.runPromise,
    );

    // None may pass before the 5000 already taken elsewhere.
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(5000);
    expect(new Set(seen).size).toBe(5);
  });
});

describe("scope: none — pass-through", () => {
  // Once the burst is spent `memory` waits on a TestClock that never moves → hung test.
  it("doesn't wait past the quota; all finish at one TestClock instant", async () => {
    const done = await Effect.gen(function* () {
      const gate = yield* make({ key: freshKey(), limit: 1, interval: "1 minutes" });
      const at: number[] = [];
      // Quota is 1/minute; fire 5 without advancing the clock.
      for (let i = 0; i < 5; i++) at.push(yield* gate(Clock.currentTimeMillis));
      return at;
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.succeed(RateLimitScopeOverride, "none" as const)),
      Effect.provide(TestClock.layer()),
      Effect.runPromise,
    );
    expect(done).toHaveLength(5);
    expect(new Set(done).size).toBe(1); // none waited
  });

  it("selectable via the process-wide default (for tests with nowhere to provide)", async () => {
    setScopeDefaultForTests("none");
    try {
      const gate = await Effect.runPromise(
        Effect.scoped(make({ key: freshKey(), limit: 1, interval: "1 minutes" })),
      );
      // No scope, no service → still pass-through.
      const at = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const first = yield* gate(Clock.currentTimeMillis);
            const second = yield* gate(Clock.currentTimeMillis);
            return [first, second];
          }),
          TestClock.layer(),
        ),
      );
      expect(at[0]).toBe(at[1]);
    } finally {
      setScopeDefaultForTests(undefined);
    }
  });

  it("the service beats the process-wide default", async () => {
    setScopeDefaultForTests("none");
    try {
      const key = freshKey();
      const started = await Effect.runPromise(
        Effect.gen(function* () {
          const gate = yield* make({ key, limit: 1, interval: "1 minutes" });
          const fiber = yield* Effect.forkChild(Effect.all([gate(Effect.void), gate(Effect.void)]));
          yield* TestClock.adjust(Duration.millis(0));
          return (yield* Effect.sync(() => fiber.pollUnsafe())) === undefined;
        }).pipe(
          Effect.scoped,
          Effect.provide(Layer.succeed(RateLimitScopeOverride, "isolated" as const)),
          Effect.provide(TestClock.layer()),
        ),
      );
      // Actually gated → the service's `isolated` won over the process-wide `none`.
      expect(started).toBe(true);
    } finally {
      setScopeDefaultForTests(undefined);
    }
  });
});
