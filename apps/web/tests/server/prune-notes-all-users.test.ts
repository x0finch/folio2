import { Effect, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { pruneNotesAllUsers } from "../../src/lib/server/entry/note-retention";

// 逐用户剪 note 的那层编排(#456)。db 那侧的 op 由 `packages/db/tests/prune-notes.test.ts` 用真 D1 盯;
// 这组只盯**编排**:窗口是怎么算出来的、一个用户失败会不会拖累其余。
//
// 用假时钟 + 注入的 `pruneOne`(不碰 D1)—— 要验的两件事都与数据库无关,而真 D1 那套夹具会把它们
// 埋在噪音里。这也是 `pruneOne` 那个注入参数存在的**唯一**理由:CODING.md 的判据是「生产会不会传它」,
// 只有测试传的字段本不该是字段 —— 所以它必须有这组测试钉着,否则就该删。
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ok = { snapshots: 2, balances: 3 };

/** 跑一次编排:假时钟停在 NOW,`pruneOne` 记下它收到的窗口下界。 */
const run = (
  userIds: readonly string[],
  pruneOne: Parameters<typeof pruneNotesAllUsers>[1],
): Promise<{ users: number; failed: number; snapshots: number; balances: number }> =>
  Effect.runPromise(
    Effect.zipRight(TestClock.setTime(NOW), pruneNotesAllUsers(userIds, pruneOne)).pipe(
      Effect.provide(TestContext.TestContext),
    ),
  );

describe("窗口下界", () => {
  it("是「现在 − 7 天」,而且取自 Clock 不是 Date.now()", async () => {
    const seen: number[] = [];
    await run(["u1"], (_userId, olderThan) => {
      seen.push(olderThan);
      return Effect.succeed(ok);
    });
    // 假时钟停在 NOW → 下界必须正好是 NOW − 7 天。读 Date.now() 的实现在这儿会算出别的数。
    expect(seen).toEqual([NOW - 7 * DAY]);
  });

  it("每个用户收到同一个下界 —— 不是各自现取一次时间", async () => {
    const seen: number[] = [];
    await run(["u1", "u2", "u3"], (_userId, olderThan) => {
      seen.push(olderThan);
      return Effect.succeed(ok);
    });
    expect(new Set(seen).size).toBe(1);
  });
});

describe("逐用户各自兜住", () => {
  it("一个用户失败,其余照样剪,计数照样对", async () => {
    const r = await run(["good1", "bad", "good2"], (userId) =>
      userId === "bad" ? Effect.fail(new Error("boom")) : Effect.succeed(ok),
    );
    expect(r).toEqual({ users: 3, failed: 1, snapshots: 4, balances: 6 });
  });

  it("**defect 也兜得住** —— 不只是类型化失败", async () => {
    // 这是 `Effect.exit` 而不是 `Effect.either` / `partition` 的理由:后者只累积类型化失败,
    // 我们自己代码抛的 TypeError、db 抛的东西会炸穿整个 effect,把整趟 cron 拖成异常收尾。
    const r = await run(["good", "boom"], (userId) =>
      userId === "boom"
        ? Effect.sync(() => {
            throw new TypeError("not a function");
          })
        : Effect.succeed(ok),
    );
    expect(r).toEqual({ users: 2, failed: 1, snapshots: 2, balances: 3 });
  });

  it("全挂 → 计数全零,但仍然正常返回(不上抛)", async () => {
    const r = await run(["a", "b"], () => Effect.fail(new Error("nope")));
    expect(r).toEqual({ users: 2, failed: 2, snapshots: 0, balances: 0 });
  });

  it("没有用户 → 什么都不做", async () => {
    let called = 0;
    const r = await run([], () => {
      called++;
      return Effect.succeed(ok);
    });
    expect(called).toBe(0);
    expect(r).toEqual({ users: 0, failed: 0, snapshots: 0, balances: 0 });
  });
});
