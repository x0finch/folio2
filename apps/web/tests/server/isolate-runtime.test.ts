import { Database } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { forUser } from "@/lib/server/runtime";
import { db } from "./_kit/db";
import { call } from "./_kit/run";
import { freshUser, otherUser } from "./_kit/user";

// The service graph is built once per isolate and the user is supplied per call; both are pinned
// through the production path. Two users share the same service instance, so isolation relies on each
// op reading its own context when it runs: same instance, two users, interleaved.

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

describe("isolate-level service graph", () => {
  it("N calls, two users -> the same ticket (built once)", async () => {
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

  it("two users hit the same handler concurrently (20 interleaved) -> each sees only their rows", async () => {
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

  // Within one fiber tree, two users' work interleaves (the cron shape).
  it("two users' ops interleave in one effect -> no cross-talk", async () => {
    await seed();
    const labelsOf = (userId: string) =>
      forUser(
        userId,
        Effect.gen(function* () {
          const database = yield* Database;
          const out: string[] = [];
          for (let i = 0; i < 5; i += 1) {
            // Yield each round to force interleaving.
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
