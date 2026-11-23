import { env } from "cloudflare:test";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { fanOutAllUsers, openSyncRound } from "@/lib/server/sync/round";
import { db } from "../_kit/db";
import { blockOutbound, type Outbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// cron opens rounds per portfolio and only opens + enqueues, never runs (the real sync is one account per queue-consumer invocation).
// This pins the shape of opening a round and that this step makes no upstream calls.

describe("sync/cron(fan-out)", () => {
  const USER = "h-sync-cron";
  let outbound: Outbound;
  let sent: Enqueued[];

  const cex = (label: string) =>
    db(USER).accounts.create({
      connectorId: "binance",
      label,
      creds: JSON.stringify({ apiKey: "k", secret: "s" }),
    });

  const roundOf = async (portfolioId: string) => {
    const got = await db(USER).syncRounds.get(portfolioId);
    return Option.getOrNull(got);
  };

  const fanOut = () =>
    Effect.runPromise(
      fanOutAllUsers([USER]).pipe(
        Effect.provideService(JobQueue, {
          poke: Effect.void,
          send: (batch) => Effect.sync(() => void sent.push(...batch)),
        }),
      ),
    );

  const syncJobs = () => sent.flatMap((m) => (m.job.kind === "sync-account" ? [m.job] : []));

  beforeEach(async () => {
    outbound = blockOutbound();
    sent = [];
    await freshUser(USER);
  });

  it("one round per portfolio, each holding only its own accounts", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "Watchlist" });
    const here = await cex("In default");
    const there = await cex("In watchlist");
    await db(USER).portfolios.assignAccount(there.id, watch.id);

    await fanOut();

    const mine = await roundOf(def.id);
    const other = await roundOf(watch.id);
    expect(Object.keys(mine?.accounts ?? {})).toEqual([here.id]);
    expect(Object.keys(other?.accounts ?? {})).toEqual([there.id]);
    // The initiator is recorded on the round header: the panel must be able to say "this round ran on schedule".
    expect(mine?.trigger).toBe("cron");
    expect(other?.trigger).toBe("cron");
  });

  it("one sync-account per account, pointing at its round; plus one set of reference-layer jobs per user", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "Watchlist" });
    const here = await cex("In default");
    const there = await cex("In watchlist");
    await db(USER).portfolios.assignAccount(there.id, watch.id);

    const result = await fanOut();

    const mine = await roundOf(def.id);
    const other = await roundOf(watch.id);
    expect(syncJobs().sort((a, b) => a.accountId.localeCompare(b.accountId))).toEqual(
      [
        {
          kind: "sync-account",
          userId: USER,
          portfolioId: def.id,
          roundId: mine?.roundId,
          accountId: here.id,
        },
        {
          kind: "sync-account",
          userId: USER,
          portfolioId: watch.id,
          roundId: other?.roundId,
          accountId: there.id,
        },
      ].sort((a, b) => a.accountId.localeCompare(b.accountId)),
    );
    // The hourly set: one message each; the two that read snapshots are delayed; the two daily ones (note pruning / catalogue) aren't here.
    const perUser = sent
      .filter((m) => m.job.kind !== "sync-account")
      .map((m) => [m.job.kind, m.delaySeconds !== undefined] as const);
    expect(perUser).toEqual([
      ["prices", false],
      ["daily-prices", false],
      ["fx", false],
      ["platforms", true],
      ["defi-logos", true],
    ]);
    // The two price jobs carry no ids: holdings are read when they run (ids are for the targeted ones enqueued by the write path).
    expect(sent.filter((m) => m.job.kind === "prices" || m.job.kind === "daily-prices")).toEqual([
      { job: { kind: "prices", userId: USER } },
      { job: { kind: "daily-prices", userId: USER } },
    ]);
    expect(result).toEqual({
      users: 1,
      accounts: 2,
      failed: 0,
      jobs: 2 + 5,
      alarms: 2 + 5,
    });
    // The round is open and not closed out: closing out is the last consumer's job.
    expect(mine?.finishedAt).toBeNull();
  });

  // The whole point: cron's single invocation no longer touches the upstream.
  it("fan-out makes no upstream calls", async () => {
    await db(USER).portfolios.ensureDefault();
    await cex("a");
    await cex("b");
    await fanOut();
    expect(syncJobs()).toHaveLength(2);
    expect(outbound.calls).toEqual([]);
  });

  // The user is manually syncing: opening a round is idempotent and returns that round as is, so cron must yield, or two waves of workers
  // would hit the upstream for the same accounts.
  it("live round still there -> cron doesn't barge in, doesn't enqueue that round's messages", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    await cex("Binance spot");
    const manualRound = await call(USER, openSyncRound({ trigger: "manual" }));
    if (manualRound.round == null) throw new Error("manual open returned no round");

    await fanOut();

    const back = await roundOf(def.id);
    expect(back?.roundId).toBe(manualRound.round.roundId);
    expect(back?.trigger).toBe("manual");
    expect(syncJobs()).toEqual([]);
  });

  // A live round holds only one account (opened by adding an account / syncing from the detail sidebar): cron can't skip the whole portfolio,
  // or the rest would miss this hour's snapshot. Pull the missing ones from the list into that round and enqueue only them; the one already there isn't re-enqueued.
  it("a live round holds only one account -> pull the rest into that round and enqueue only them", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const busy = await cex("Syncing alone");
    const other = await cex("The rest");
    const single = await db(USER).syncRounds.open({
      portfolioId: def.id,
      roundId: "single",
      trigger: "manual",
      accounts: [{ id: busy.id, label: busy.label }],
      ttlMs: 120_000,
    });
    expect(single.opened).toBe(true);

    const result = await fanOut();

    const back = await roundOf(def.id);
    expect(back?.roundId).toBe("single");
    expect(back?.accounts[other.id]?.status).toBe("pending");
    expect(back?.accounts[busy.id]?.status).toBe("pending");
    expect(syncJobs().map((j) => [j.roundId, j.accountId])).toEqual([["single", other.id]]);
    expect(result.accounts).toBe(1);
  });

  // Enqueue blew up (queue missing / quota exhausted): a round opened mustn't sit pending for 120s and then read as a reasonless "interrupted";
  // same policy as the manual path: close out with a message. Accounts pulled into someone else's round are recorded failed.
  it("enqueue failure -> a round it opened closes out with a message, accounts pulled into another's round are recorded failed; this user counts as failed", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "Watchlist" });
    const busy = await cex("Syncing alone");
    const joined = await cex("Pulled in");
    const there = await cex("In watchlist");
    await db(USER).portfolios.assignAccount(there.id, watch.id);
    await db(USER).syncRounds.open({
      portfolioId: def.id,
      roundId: "single",
      trigger: "manual",
      accounts: [{ id: busy.id, label: busy.label }],
      ttlMs: 120_000,
    });

    const result = await Effect.runPromise(
      fanOutAllUsers([USER]).pipe(
        Effect.provideService(JobQueue, {
          poke: Effect.void,
          send: () => Effect.die(new Error("queue down")),
        }),
      ),
    );

    expect(result).toMatchObject({ users: 1, failed: 1, jobs: 0 });
    const mine = await roundOf(watch.id);
    expect(mine?.trigger).toBe("cron");
    expect(mine?.finishedAt).not.toBeNull();
    expect(mine?.error).toBeTruthy();
    const theirs = await roundOf(def.id);
    expect(theirs?.roundId).toBe("single");
    expect(theirs?.accounts[joined.id]?.status).toBe("failed");
    expect(theirs?.accounts[busy.id]?.status).toBe("pending");
    expect(theirs?.finishedAt).toBeNull();
  });

  // Blew up before enqueueing: when opening the later portfolio's round hits a D1 error, rounds already opened mustn't sit pending 120s and read as a
  // reasonless "interrupted"; same wrap-up as an enqueue failure. A trigger that blocks only that portfolio simulates the D1 failure.
  it("a later portfolio's round blows up on open -> earlier opened rounds close out with a message; this user counts as failed", async () => {
    await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "Watchlist" });
    await cex("In default");
    const there = await cex("In watchlist");
    await db(USER).portfolios.assignAccount(there.id, watch.id);
    const order = (await db(USER).portfolios.list()).map((p) => p.id);
    const [first, last] = [order[0], order[order.length - 1]];
    if (!first || !last || first === last) throw new Error("need two portfolios");
    await env.DB.prepare(
      `CREATE TRIGGER fail_open_last BEFORE INSERT ON user_cache WHEN NEW.k LIKE '%${last}%'
       BEGIN SELECT RAISE(ABORT, 'd1 down'); END`,
    ).run();
    try {
      const result = await fanOut();
      expect(result).toMatchObject({ users: 1, failed: 1, jobs: 0 });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_open_last").run();
    }

    expect(sent).toEqual([]);
    const opened = await roundOf(first);
    expect(opened?.trigger).toBe("cron");
    expect(opened?.finishedAt).not.toBeNull();
    expect(opened?.error).toBeTruthy();
    expect(await roundOf(last)).toBeNull();
  });

  // A round that was opened must be closed out, an empty portfolio included: no message will close it and after 120s the panel would show a bare "interrupted".
  it("an empty portfolio's round closes out on the spot, no message enqueued", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    await fanOut();
    const back = await roundOf(def.id);
    expect(back?.accounts).toEqual({});
    expect(back?.finishedAt).not.toBeNull();
    expect(syncJobs()).toEqual([]);
  });
});
