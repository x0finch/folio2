import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Enqueued } from "@/lib/server/jobs/queue";
import { fanOutAllUsers } from "@/lib/server/sync/round";

// Cron fan-out: per-user round then enqueue, serially and each user isolated. What each user enqueues
// is covered in sync/cron.cases.ts; `fanOutOne` is injected, so no D1 here.
// Lives in tests/server (workers pool): importing round.ts pulls in `cloudflare:workers`.

const job = (userId: string, accountId: string): Enqueued => ({
  job: { kind: "sync-account", userId, portfolioId: "pf", roundId: "r", accountId },
});

const run = (userIds: string[], fanOutOne: (userId: string) => Effect.Effect<Enqueued[], Error>) =>
  Effect.runPromise(fanOutAllUsers(userIds, fanOutOne)).then((result) => ({ result }));

describe("fanOutAllUsers", () => {
  it("users run serially, never overlapping", async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fanOutOne = (userId: string) =>
      Effect.promise(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        events.push(`start:${userId}`);
        // Yield so real concurrency would let other users slip in here.
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        events.push(`end:${userId}`);
        return [job(userId, `${userId}-acc`)];
      });

    const { result } = await run(["u1", "u2", "u3"], fanOutOne);

    expect(maxInFlight).toBe(1);
    expect(events).toEqual(["start:u1", "end:u1", "start:u2", "end:u2", "start:u3", "end:u3"]);
    expect(result).toEqual({ users: 3, accounts: 3, failed: 0, jobs: 3, alarms: 3 });
  });

  it("subtotals count what was enqueued: sync-account count, total count, queue-ops estimate", async () => {
    const prices = (userId: string): Enqueued => ({ job: { kind: "prices", userId } });
    const { result } = await run(["a", "b"], (userId) =>
      Effect.succeed([job(userId, `${userId}-1`), job(userId, `${userId}-2`), prices(userId)]),
    );
    expect(result).toEqual({ users: 2, accounts: 4, failed: 0, jobs: 6, alarms: 6 });
  });

  // One user blowing up (a defect, not a typed failure) must not stop the users after them.
  it("a user defect -> the rest are still enqueued, nothing throws, one counted as failed", async () => {
    const seen: string[] = [];
    const { result } = await run(["a", "b", "c"], (userId) =>
      Effect.sync(() => {
        seen.push(userId);
        if (userId === "b") throw new TypeError("cannot read properties of undefined");
        return [job(userId, `${userId}-acc`)];
      }),
    );

    expect(seen).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ users: 3, accounts: 2, failed: 1, jobs: 2, alarms: 2 });
  });

  it("empty list: zero calls", async () => {
    const { result } = await run([], () => Effect.succeed([]));
    expect(result).toEqual({ users: 0, accounts: 0, failed: 0, jobs: 0, alarms: 0 });
  });
});
