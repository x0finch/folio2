import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { syncAllUsers, warmAllUsers } from "../../src/lib/server/sync/deps";

// #375 第 2 步 · 纵深防御:sweep 收尾逐用户预热,一个用户失败不该拖垮其余、也不该把整次 cron
// 拖成异常收尾。`warmAllUsers` 收一个可注入的 `warmOne` 正是为了在这里让指定用户失败 ——
// 生产路径用默认的 `warmTokens`(碰真 db/oracle),这一层的逻辑只有「兜住 + 计数」。
//
// 放在 tests/server/(workers pool):import sync-deps 会连带 `cloudflare:workers`,只有这个 pool 解析得了。
// 但本用例不碰 D1 —— 全靠注入的假 `warmOne`。
describe("warmAllUsers", () => {
  it("某个用户失败:其余用户照样预热,整体不抛,计数分明", async () => {
    const seen: string[] = [];
    const warmOne = vi.fn((userId: string) =>
      Effect.gen(function* () {
        seen.push(userId);
        if (userId === "b") {
          return yield* Effect.fail(new Error("coingecko rate limited: /api/v3/simple/price"));
        }
      }),
    );

    const report = await Effect.runPromise(warmAllUsers(["a", "b", "c"], warmOne));

    // b 失败了,但 c 仍被调用 —— 循环没有被一个用户的失败中断。
    expect(seen).toEqual(["a", "b", "c"]);
    expect(report).toEqual({ warmed: 2, failed: 1 });
  });

  // **这条是 `Effect.partition` 过不了的那条。** 官方的错误累积算子内部是 `Effect.either`,
  // 只累积类型化失败;defect(自家 bug 抛的 TypeError 之类)会炸穿整个 effect,把 cron 带走。
  // #375 要兜的恰恰包含这一类,所以 `warmAllUsers` 用的是 `Effect.exit`。
  it("某个用户抛的是 defect(不是类型化失败):照样兜住,其余照跑", async () => {
    const seen: string[] = [];
    const warmOne = vi.fn((userId: string) =>
      Effect.sync(() => {
        seen.push(userId);
        if (userId === "b") throw new TypeError("cannot read properties of undefined");
      }),
    );

    const report = await Effect.runPromise(warmAllUsers(["a", "b", "c"], warmOne));

    expect(seen).toEqual(["a", "b", "c"]);
    expect(report).toEqual({ warmed: 2, failed: 1 });
  });

  it("全部成功", async () => {
    const warmOne = vi.fn(() => Effect.void);
    const report = await Effect.runPromise(warmAllUsers(["a", "b"], warmOne));
    expect(report).toEqual({ warmed: 2, failed: 0 });
  });

  it("空名单:零调用、零计数", async () => {
    const warmOne = vi.fn(() => Effect.void);
    const report = await Effect.runPromise(warmAllUsers([], warmOne));
    expect(warmOne).not.toHaveBeenCalled();
    expect(report).toEqual({ warmed: 0, failed: 0 });
  });
});

// cron 的 sweep 与预热是同一个形状:逐用户、串行、各自兜住。串行是**有意的**(cron 一次调用有
// CPU / subrequest 预算),而这条约束原先由 `@folio/sync` 的一条用例钉着 —— 循环搬到 app 之后,
// 那条钉的就成了包里自己那份复刻:**在这里加 concurrency 它照样绿**。所以钉子跟过来。
describe("syncAllUsers", () => {
  it("逐用户串行,不重叠", async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const tallyOne = (userId: string) =>
      Effect.promise(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        events.push(`start:${userId}`);
        // 让出事件循环:真并发的话别的用户会在这个缝里挤进来。
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        events.push(`end:${userId}`);
        return { ok: 1, failed: 0, skipped: 0 };
      });

    const result = await Effect.runPromise(syncAllUsers(["u1", "u2", "u3"], tallyOne));

    expect(maxInFlight).toBe(1);
    expect(events).toEqual(["start:u1", "end:u1", "start:u2", "end:u2", "start:u3", "end:u3"]);
    expect(result).toEqual({ users: 3, ok: 3, failed: 0, skipped: 0 });
  });
});
