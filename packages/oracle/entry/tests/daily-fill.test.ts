import { DAILY_FILL_DAYS_PER_CALL, MS_PER_DAY } from "@folio/oracle-basic";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { type DailySource, fillDaily } from "../src/daily-fill";
import { harness, now0 } from "./fakes";

// Accounting of the attempted range under concurrency: two `daily-prices` messages can fill one target at once
// (cron, targeted fill, redelivery; queue `max_concurrency` > 1). The slower one must not shrink the range,
// which would re-hit windows upstream has no points for.

const TODAY = Math.floor(now0 / MS_PER_DAY);
const WINDOWS = 3;
const FROM_MS = (TODAY - WINDOWS * DAILY_FILL_DAYS_PER_CALL) * MS_PER_DAY;

/** Upstream has no points for these windows (returns empty) and the table is empty: only the attempted range prevents refetching. */
const emptySource = (calls: [number, number][], gate?: Deferred.Deferred<void>): DailySource => ({
  callsPerWindow: 1,
  read: () => Effect.succeed(new Map()),
  fetch: (fromB, toB) =>
    Effect.gen(function* () {
      calls.push([fromB, toB]);
      if (gate) yield* Deferred.await(gate);
      return new Map<number, number>();
    }),
  write: () => Effect.void,
});

describe("fillDaily range unions under concurrency", () => {
  it("two concurrent fills: the one with less progress finishing last does not shrink the range; third run has zero egress", async () => {
    const h = harness();
    await h.run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const slowCalls: [number, number][] = [];
        const fastCalls: [number, number][] = [];

        // The slow one: budget for one window, stuck on fetch after reading the (empty) range.
        const slow = yield* Effect.fork(
          fillDaily(h.cache, "tk_x", emptySource(slowCalls, gate), FROM_MS, 1, "test.slow"),
        );
        while (slowCalls.length === 0) yield* Effect.yieldNow();

        // The fast one plans from the same empty range, fills all three windows, writes first.
        const fast = yield* fillDaily(
          h.cache,
          "tk_x",
          emptySource(fastCalls),
          FROM_MS,
          10,
          "test.fast",
        );
        expect(fast).toEqual({ calls: WINDOWS, done: true, failed: false });

        // The slow one writes now: it only advanced one window.
        yield* Deferred.succeed(gate, undefined);
        const slowReport = yield* Fiber.join(slow);
        expect(slowReport).toEqual({ calls: 1, done: false, failed: false });

        // After the union the range is still whole: the next run makes no calls.
        const again: [number, number][] = [];
        const third = yield* fillDaily(h.cache, "tk_x", emptySource(again), FROM_MS, 10, "t3");
        expect(third).toEqual({ calls: 0, done: true, failed: false });
        expect(again).toEqual([]);
      }),
    );
  });

  it("reverse: the one with more progress finishing last still yields the whole range (union is order-independent)", async () => {
    const h = harness();
    await h.run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const bigCalls: [number, number][] = [];
        const big = yield* Effect.fork(
          fillDaily(h.cache, "tk_y", emptySource(bigCalls, gate), FROM_MS, 10, "test.big"),
        );
        while (bigCalls.length === 0) yield* Effect.yieldNow();
        yield* fillDaily(h.cache, "tk_y", emptySource([]), FROM_MS, 1, "test.small");
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(big);

        const again: [number, number][] = [];
        yield* fillDaily(h.cache, "tk_y", emptySource(again), FROM_MS, 10, "t3");
        expect(again).toEqual([]);
      }),
    );
  });
});
