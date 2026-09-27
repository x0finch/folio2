import { Database } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { forUser } from "@/lib/server/runtime";
import { db } from "./_kit/db";
import { call } from "./_kit/run";
import { freshUser, otherUser } from "./_kit/user";

// **服务图每个 isolate 建一次,用户在每次调用时给**(ADR 0054)—— 这两件事在生产那条路上钉住。
//
// 以前「拿错用户在编译期就发生不了」有一半是靠「每请求按 userId 建一套服务」:服务实例与用户
// 一一对应。现在两个用户拿的是**同一个**服务实例,隔离全靠「op 跑的那一刻读到的是自己那份
// context」。所以要钉的正是最容易出事的那种情形:同一个实例、两个用户、交错着跑。

const USER_A = "user-isolate-a";
const USER_B = otherUser(USER_A);

beforeEach(async () => {
  await freshUser(USER_A);
  await freshUser(USER_B);
});

const seed = async () => {
  for (let i = 0; i < 3; i += 1) {
    await db(USER_A).accounts.create({ connectorId: "manual", label: `A${i}`, creds: null });
    await db(USER_B).accounts.create({ connectorId: "manual", label: `B${i}`, creds: null });
  }
};

describe("isolate 级的服务图", () => {
  it("N 次调用、两个用户 → 同一份门票(只建了一次)", async () => {
    const tickets = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call(i % 2 ? USER_A : USER_B, Effect.zip(Database, Oracle)),
      ),
    );
    const [first] = tickets;
    for (const [database, oracle] of tickets) {
      expect(database).toBe(first?.[0]);
      expect(oracle).toBe(first?.[1]);
    }
  });

  it("两个用户并发打同一个 handler(20 发交错)→ 各自只看得见自己的行", async () => {
    await seed();
    const users = Array.from({ length: 20 }, (_, i) => (i % 2 ? USER_A : USER_B));
    const results = await Promise.all(users.map((u) => call(u, handleListAccounts({}))));
    results.forEach((rows, i) => {
      const owner = users[i];
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.userId === owner)).toBe(true);
      const prefix = owner === USER_A ? "A" : "B";
      expect(rows.every((r) => r.label.startsWith(prefix))).toBe(true);
    });
  });

  // 最刁的那种:**一条 fiber 树里**两个用户的活交错跑(cron 就是这个形状)。两段各自 `forUser`,
  // 共享同一个 `Database` 实例,而每个 op 在跑的那一刻读的是自己那段的 context。
  it("同一个 effect 里两个用户的 op 交错跑 → 互不串", async () => {
    await seed();
    const labelsOf = (userId: string) =>
      forUser(
        userId,
        Effect.gen(function* () {
          const database = yield* Database;
          const out: string[] = [];
          for (let i = 0; i < 5; i += 1) {
            // 每轮让出一次,逼两个用户的 op 在调度器上交错。
            yield* Effect.yieldNow();
            const rows = yield* database.accounts.list();
            out.push(...rows.map((r) => r.userId));
          }
          return out;
        }),
      );
    const [a, b] = await Effect.runPromise(
      Effect.all([labelsOf(USER_A), labelsOf(USER_B)], { concurrency: "unbounded" }),
    );
    expect(a).toHaveLength(15);
    expect(new Set(a)).toEqual(new Set([USER_A]));
    expect(b).toHaveLength(15);
    expect(new Set(b)).toEqual(new Set([USER_B]));
  });
});
