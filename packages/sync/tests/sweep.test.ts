import { ConnectorFailure } from "@folio/connectors-basic";
import type { AccountSafe } from "@folio/db";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Sweep } from "../src";
import { type FakeOptions, fakeServices } from "./fakes";

// 「所有用户」那个循环搬去 `apps/web` 了(#403 片 3):服务是 per-user 的,一份服务服务不了多个
// 用户,所以「逐用户装配 + 累加」属于做装配的那一方。本包只交出 `userTally` 与 `sumTallies` ——
// 这里照生产那边的写法把它们拼起来,于是**这些用例仍然钉着同一件事**:聚合口径、用户级隔离、串行。
const sweep = (userIds: string[], servicesFor: (userId: string) => FakeOptions) =>
  Effect.runPromise(
    Effect.forEach(userIds, (userId) =>
      Sweep.userTally(userId).pipe(Effect.provide(fakeServices(servicesFor(userId)).layer)),
    ).pipe(Effect.map((tallies) => Sweep.sumTallies(userIds.length, tallies))),
  );

// manual 账户(成功路径);failing 账户(fetchBalances 抛 → syncAccount 捕获 → ok:false)。
function manual(id: string, userId: string): AccountSafe {
  return {
    id,
    userId,
    connectorId: "manual",
    platform: null,
    label: id,
    createdAt: 0,
    archivedAt: null,
  };
}
function badType(id: string, userId: string): AccountSafe {
  return {
    id,
    userId,
    connectorId: "binance",
    platform: null,
    label: id,
    createdAt: 0,
    archivedAt: null,
  };
}

// 按 userId 给各自的假装配。manual → ok;其余 → 失败(模拟取数失败)。
const optionsFor =
  (accountsByUser: Record<string, AccountSafe[]>) =>
  (userId: string): FakeOptions => ({
    accounts: accountsByUser[userId] ?? [],
    fetch: (account) =>
      account.connectorId === "manual"
        ? Effect.succeed({ status: "ok", balances: [], totalUsd: 0 } as const)
        : Effect.fail(
            new ConnectorFailure({
              message: `fetch failed for connectorId: ${account.connectorId}`,
            }),
          ),
  });

describe("逐用户 sweep(cron)", () => {
  it("sweeps every user and aggregates ok/failed account counts", async () => {
    const res = await sweep(
      ["u1", "u2", "u3"],
      optionsFor({
        u1: [manual("a1", "u1")],
        u2: [manual("a2", "u2"), badType("a3", "u2")], // a3 无 provider → failed
        u3: [], // 无账户
      }),
    );
    expect(res).toEqual({ users: 3, ok: 2, failed: 1, skipped: 0 });
  });

  it("isolates a user whose account read throws — others still sync", async () => {
    const base = optionsFor({ u1: [manual("a1", "u1")], u2: [manual("a2", "u2")] });
    const res = await sweep(["u1", "u2"], (userId) => ({
      ...base(userId),
      accounts:
        userId === "u1"
          ? () => Promise.reject(new Error("db blip"))
          : (base(userId).accounts as AccountSafe[]),
    }));
    expect(res.users).toBe(2);
    expect(res.ok).toBe(1); // u2 仍成功
    expect(res.failed).toBe(1); // u1 抛错被隔离计为失败
  });

  it("handles an empty user list", async () => {
    const res = await sweep([], optionsFor({}));
    expect(res).toEqual({ users: 0, ok: 0, failed: 0, skipped: 0 });
  });
});

// sweep 串行是**有意的**(cron 一次调用有 CPU / subrequest 预算,几十个用户并发会顶穿 ——
// 见 apps/web server.ts 里两个 trigger 拆开的理由)。Effect 化时 `Effect.forEach` 默认就是串行,
// 但「默认串行」不是保证 —— 谁哪天顺手加个 `{ concurrency: ... }` 就悄悄变了。这条钉住它。
describe("逐用户 sweep — 串行", () => {
  it("逐用户串行,不重叠", async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const users = ["u1", "u2", "u3"];
    const res = await sweep(users, (userId) => ({
      accounts: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        events.push(`start:${userId}`);
        // 让出事件循环:真并发的话别的用户会在这个缝里挤进来。
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        events.push(`end:${userId}`);
        return [manual(`a-${userId}`, userId)];
      },
    }));
    expect(res.users).toBe(3);
    expect(maxInFlight).toBe(1);
    expect(events).toEqual(["start:u1", "end:u1", "start:u2", "end:u2", "start:u3", "end:u3"]);
  });
});

// 流式产出:主页「立即同步」要边跑边显示进度,所以 syncUserStream 逐账户吐结果而不是攒到最后。
describe("Sweep.syncUserStream — 逐账户产出", () => {
  it("先完成先报:慢账户不挡住后完成的快账户", async () => {
    const seen: string[] = [];
    const delays: Record<string, number> = { slow: 40, fast: 1 };
    const { layer } = fakeServices({
      accounts: [manual("slow", "u1"), manual("fast", "u1")],
      fetch: (a) =>
        Effect.promise(async () => {
          await new Promise((r) => setTimeout(r, delays[a.id] ?? 0));
          return { status: "ok", balances: [], totalUsd: 0 } as const;
        }),
    });
    await Effect.runPromise(
      Sweep.syncUserStream("u1").pipe(
        Stream.provideLayer(layer),
        Stream.runForEach((r) => Effect.sync(() => void seen.push(r.accountId))),
      ),
    );
    // 账户列表里 slow 在前,但它慢 —— 保序的话 fast 得等它,流就没意义了。
    expect(seen).toEqual(["fast", "slow"]);
  });

  it("逐个产出而非一次性给完:第一个结果先于最后一个账户完成就到手", async () => {
    let firstSeenWhileRunning = false;
    let done = 0;
    const { layer } = fakeServices({
      accounts: [manual("a1", "u1"), manual("a2", "u1"), manual("a3", "u1")],
      fetch: () =>
        Effect.promise(async () => {
          await new Promise((r) => setTimeout(r, 5));
          done++;
          return { status: "ok", balances: [], totalUsd: 0 } as const;
        }),
    });
    await Effect.runPromise(
      Sweep.syncUserStream("u1").pipe(
        Stream.provideLayer(layer),
        Stream.runForEach(() =>
          Effect.sync(() => {
            if (done < 3) firstSeenWhileRunning = true;
          }),
        ),
      ),
    );
    expect(firstSeenWhileRunning).toBe(true);
  });
});
