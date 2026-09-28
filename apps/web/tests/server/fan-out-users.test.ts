import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { fanOutAllUsers } from "@/lib/server/sync/round";

// cron 的 fan-out(FOL-86):逐用户开轮 → 投消息,**逐用户串行、各自兜住**。
// 以前这两条约束钉在 `syncAllUsers` / `warmAllUsers` 上;同步与预热搬进队列之后,cron 那一次调用里
// 剩下的就是这一圈,钉子跟过来。`fanOutOne` 注入,本文件不碰 D1。
//
// 放在 tests/server/(workers pool):import round.ts 会连带 `cloudflare:workers`,只有这个 pool 解析得了。

const job = (userId: string, accountId: string): Enqueued => ({
  job: { kind: "sync-account", userId, portfolioId: "pf", roundId: "r", accountId },
});

const run = (
  userIds: string[],
  fanOutOne: (userId: string) => Effect.Effect<Enqueued[], Error>,
) => {
  const sent: Enqueued[] = [];
  return Effect.runPromise(
    fanOutAllUsers(userIds, fanOutOne).pipe(
      Effect.provideService(JobQueue, {
        send: (batch) => Effect.sync(() => void sent.push(...batch)),
      }),
    ),
  ).then((result) => ({ result, sent }));
};

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
    expect(result).toEqual({ users: 3, accounts: 3, failed: 0 });
  });

  // `prices` 不延后(FOL-87):同步只读价表,两者不排先后。
  // FOL-88:参考层按件拆开,一件一条;读快照的两件延后到同步落库之后。
  it("每个用户在自己的同步消息之后补 prices / daily-prices / fx(不延后)与 platforms / defi-logos(延后)", async () => {
    const { sent } = await run(["a", "b"], (userId) =>
      Effect.succeed([job(userId, `${userId}-1`), job(userId, `${userId}-2`)]),
    );
    expect(sent.map((m) => `${m.job.kind}:${m.job.userId}`)).toEqual([
      "sync-account:a",
      "sync-account:a",
      "prices:a",
      "daily-prices:a",
      "fx:a",
      "platforms:a",
      "defi-logos:a",
      "sync-account:b",
      "sync-account:b",
      "prices:b",
      "daily-prices:b",
      "fx:b",
      "platforms:b",
      "defi-logos:b",
    ]);
    for (const m of sent) {
      if (m.job.kind === "platforms" || m.job.kind === "defi-logos")
        expect(m.delaySeconds).toBeGreaterThan(0);
      else expect(m.delaySeconds).toBeUndefined();
    }
  });

  // 一个用户炸(defect —— db 挂了那种,不是类型化失败)不拖累后面的用户。没有这层隔离,
  // 整点 cron 里排在坏用户后面的**所有人**这一小时都不同步。
  it("某个用户 defect → 其余照投,整体不抛,计一个 failed、不投他的 prices / 参考层活", async () => {
    const seen: string[] = [];
    const { result, sent } = await run(["a", "b", "c"], (userId) =>
      Effect.sync(() => {
        seen.push(userId);
        if (userId === "b") throw new TypeError("cannot read properties of undefined");
        return [job(userId, `${userId}-acc`)];
      }),
    );

    expect(seen).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ users: 3, accounts: 2, failed: 1 });
    expect(sent.some((m) => m.job.userId === "b")).toBe(false);
  });

  it("空名单:零调用、零投递", async () => {
    const { result, sent } = await run([], () => Effect.succeed([]));
    expect(result).toEqual({ users: 0, accounts: 0, failed: 0 });
    expect(sent).toEqual([]);
  });
});
