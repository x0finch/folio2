import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Enqueued } from "@/lib/server/jobs/queue";
import { fanOutAllUsers } from "@/lib/server/sync/round";

// cron 的 fan-out(FOL-86):逐用户开轮 → 投消息,**逐用户串行、各自兜住**。每个用户投什么
// (连同 `hourlyUserJobs`、投递失败怎么收尾)归 `fanOutUserRounds`,钉在 sync/cron.cases.ts。
// 以前这两条约束钉在 `syncAllUsers` / `warmAllUsers` 上;同步与预热搬进队列之后,cron 那一次调用里
// 剩下的就是这一圈,钉子跟过来。`fanOutOne` 注入,本文件不碰 D1。
//
// 放在 tests/server/(workers pool):import round.ts 会连带 `cloudflare:workers`,只有这个 pool 解析得了。

const job = (userId: string, accountId: string): Enqueued => ({
  job: { kind: "sync-account", userId, portfolioId: "pf", roundId: "r", accountId },
});

const run = (userIds: string[], fanOutOne: (userId: string) => Effect.Effect<Enqueued[], Error>) =>
  Effect.runPromise(fanOutAllUsers(userIds, fanOutOne)).then((result) => ({ result }));

describe("fanOutAllUsers", () => {
  it("逐用户串行,不重叠", async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fanOutOne = (userId: string) =>
      Effect.promise(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        events.push(`start:${userId}`);
        // 让出事件循环:真并发的话别的用户会在这个缝里挤进来。
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        events.push(`end:${userId}`);
        return [job(userId, `${userId}-acc`)];
      });

    const { result } = await run(["u1", "u2", "u3"], fanOutOne);

    expect(maxInFlight).toBe(1);
    expect(events).toEqual(["start:u1", "end:u1", "start:u2", "end:u2", "start:u3", "end:u3"]);
    expect(result).toEqual({ users: 3, accounts: 3, failed: 0, jobs: 3, queueOps: 3 * 3 });
  });

  it("小计按投出去的那一批数:sync-account 条数、总条数、队列操作估算", async () => {
    const prices = (userId: string): Enqueued => ({ job: { kind: "prices", userId } });
    const { result } = await run(["a", "b"], (userId) =>
      Effect.succeed([job(userId, `${userId}-1`), job(userId, `${userId}-2`), prices(userId)]),
    );
    expect(result).toEqual({ users: 2, accounts: 4, failed: 0, jobs: 6, queueOps: 6 * 3 });
  });

  // 一个用户炸(defect —— db 挂了那种,不是类型化失败)不拖累后面的用户。没有这层隔离,
  // 整点 cron 里排在坏用户后面的**所有人**这一小时都不同步。
  it("某个用户 defect → 其余照投,整体不抛,计一个 failed", async () => {
    const seen: string[] = [];
    const { result } = await run(["a", "b", "c"], (userId) =>
      Effect.sync(() => {
        seen.push(userId);
        if (userId === "b") throw new TypeError("cannot read properties of undefined");
        return [job(userId, `${userId}-acc`)];
      }),
    );

    expect(seen).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ users: 3, accounts: 2, failed: 1, jobs: 2, queueOps: 2 * 3 });
  });

  it("空名单:零调用", async () => {
    const { result } = await run([], () => Effect.succeed([]));
    expect(result).toEqual({ users: 0, accounts: 0, failed: 0, jobs: 0, queueOps: 0 });
  });
});
