import { DAILY_FILL_DAYS_PER_CALL, MS_PER_DAY } from "@folio/oracle-basic";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { type DailySource, fillDaily } from "../src/daily-fill";
import { harness, now0 } from "./fakes";

// 「试过哪一段」在并发下的记账(code review #9)。同一个目标会有两条 `daily-prices` 同时在补
// (整点 cron + 手记写完的定向补 + 重投,队列 `max_concurrency` > 1)。进度少、后写完的那条
// 不许把区间**盖小** —— 盖小的代价正是这张区间要省掉的:上游本就没有点的窗被重新打一遍。

const TODAY = Math.floor(now0 / MS_PER_DAY);
const WINDOWS = 3;
const FROM_MS = (TODAY - WINDOWS * DAILY_FILL_DAYS_PER_CALL) * MS_PER_DAY;

/** 上游对这几窗**就是没有点**(回空),而表也空 —— 只有「试过的区间」能挡住重打。 */
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

describe("fillDaily 的区间在并发下取并集", () => {
  it("两条同时补:进度少的那条后写完也不把区间盖小,第三趟零出网", async () => {
    const h = harness();
    await h.run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const slowCalls: [number, number][] = [];
        const fastCalls: [number, number][] = [];

        // 慢的那条:预算只够一窗,读完区间(空)就卡在回源上。
        const slow = yield* Effect.fork(
          fillDaily(h.cache, "tk_x", emptySource(slowCalls, gate), FROM_MS, 1, "test.slow"),
        );
        while (slowCalls.length === 0) yield* Effect.yieldNow();

        // 快的那条从同一个空区间规划,三窗全补完、先写。
        const fast = yield* fillDaily(
          h.cache,
          "tk_x",
          emptySource(fastCalls),
          FROM_MS,
          10,
          "test.fast",
        );
        expect(fast).toEqual({ calls: WINDOWS, done: true, failed: false });

        // 慢的那条这才写:它只推进了一窗。
        yield* Deferred.succeed(gate, undefined);
        const slowReport = yield* Fiber.join(slow);
        expect(slowReport).toEqual({ calls: 1, done: false, failed: false });

        // 并集之后区间仍是整段 → 下一趟一发都不打。
        const again: [number, number][] = [];
        const third = yield* fillDaily(h.cache, "tk_x", emptySource(again), FROM_MS, 10, "t3");
        expect(third).toEqual({ calls: 0, done: true, failed: false });
        expect(again).toEqual([]);
      }),
    );
  });

  it("反过来:进度多的那条后写完,照样是整段(并集不挑谁先谁后)", async () => {
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
