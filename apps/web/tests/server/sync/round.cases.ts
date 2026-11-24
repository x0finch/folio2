import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { JobQueue } from "@/lib/server/jobs/queue";
import {
  handleGetSyncRound,
  openSyncRound,
  ROUND_HEARTBEAT_MS,
  ROUND_RETENTION_MS,
  startSyncRound,
} from "@/lib/server/sync/round";
import { db } from "../_kit/db";
import { blockOutbound, type Outbound } from "../_kit/outbound";
import { captureQueue, consumeJob } from "../_kit/queue";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// Opening / reading a round, against real D1: correctness hinges on which accounts enter the round and on both sides computing the
// same key, which need real account rows and portfolio membership.

describe("sync/round", () => {
  const USER = "h-sync-round";

  const cex = (label: string) =>
    db(USER).accounts.create({
      connectorId: "binance",
      label,
      creds: JSON.stringify({ apiKey: "k", secret: "s" }),
    });

  const manual = (label: string) =>
    db(USER).accounts.create({ connectorId: "manual", label, creds: null });

  // The assertion side unwraps `round` as non-null: these cases can't produce a row deleted between two statements, and if it happened it should blow up.
  const open = async (portfolioId?: string) => {
    const out = await call(USER, openSyncRound({ portfolioId, trigger: "manual" }));
    if (out.round == null) throw new Error("open returned no round — the row vanished mid-test?");
    return { opened: out.opened, round: out.round };
  };

  const read = (portfolioId: string) => call(USER, handleGetSyncRound({ portfolioId }));

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
  });

  describe("opening a round", () => {
    it("list = in the current portfolio, active, non-manual -- same criterion as the page header summary", async () => {
      const live = await cex("Binance spot");
      const archived = await cex("Old account");
      await db(USER).accounts.setArchived(archived.id, true);
      await manual("Manual");

      const { round, opened } = await open();
      expect(opened).toBe(true);
      expect(Object.keys(round.accounts)).toEqual([live.id]);
      expect(round.accounts[live.id]).toEqual({ label: "Binance spot", status: "pending" });
      expect(round.trigger).toBe("manual");
      expect(round.finishedAt).toBeNull();
    });

    it("accounts in another portfolio don't enter this round", async () => {
      const here = await cex("In default");
      const there = await cex("In watchlist");
      const watch = await db(USER).portfolios.create({ name: "Watchlist" });
      await db(USER).portfolios.assignAccount(there.id, watch.id);

      const mine = await open();
      expect(Object.keys(mine.round.accounts)).toEqual([here.id]);
      const other = await open(watch.id);
      expect(Object.keys(other.round.accounts)).toEqual([there.id]);
    });

    // A second device clicks sync / cron collides with a manual one: it sees the same round, not one cleared and restarted.
    it("live round still there -> a second open returns the same round", async () => {
      await cex("Binance spot");
      const first = await open();
      const second = await open();
      expect(second.opened).toBe(false);
      expect(second.round.roundId).toBe(first.round.roundId);
    });

    it("heartbeat = the moment of opening + 120s", async () => {
      await cex("Binance spot");
      const before = Date.now();
      const { round } = await open();
      expect(round.expiresAt).toBeGreaterThanOrEqual(before + ROUND_HEARTBEAT_MS);
      expect(ROUND_RETENTION_MS).toBeGreaterThan(ROUND_HEARTBEAT_MS);
    });
  });

  describe("reading a round", () => {
    it("this portfolio never opened one -> null (not an empty round)", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      expect(await read(pf.id)).toBeNull();
    });

    it("a just-opened round -> running, x / N starts at 0, the first one is syncing", async () => {
      await cex("Binance spot");
      await cex("Kraken");
      await open();

      const pf = await db(USER).portfolios.ensureDefault();
      const view = await read(pf.id);
      expect(view?.state).toBe("running");
      expect(view?.total).toBe(2);
      expect(view?.settled).toBe(0);
      expect(view?.synced).toBe(0);
      expect(view?.failed).toEqual([]);
      expect(view?.current).toBe("Binance spot");
    });

    // Opening falls back to the default portfolio for a bad id (a round must land on a real portfolio); reading doesn't resolve, it reads the key directly:
    // this is the 1.5s-polled path, saving two queries, and the key is user-scoped so a bad id only reads an empty key. The client only sends
    // ids that exist in the selector, so on real traffic both sides land on the same key.
    it("opening with a bad id lands on the default portfolio; reading with the real id finds it, with the bad id finds empty", async () => {
      await cex("Binance spot");
      const opened = await open("pf-never-existed");
      const def = await db(USER).portfolios.ensureDefault();
      expect(opened.round.portfolioId).toBe(def.id);
      expect((await read(def.id))?.roundId).toBe(opened.round.roundId);
      expect(await read("pf-also-nonsense")).toBeNull();
    });
  });

  // The `POST /api/sync` round: open a round, enqueue messages, return at once, with no upstream calls; sync runs in the queue consumer
  // (outbound is cut off, so the one with credentials must fail). Tests the wiring: which messages were enqueued, results landing per message
  // in the round, the three tiers split correctly, the last one closes it out.
  describe("manual / automatic rounds (startSyncRound)", () => {
    let outbound: Outbound;
    let queue: ReturnType<typeof captureQueue>;

    const start = async (auto = false, portfolioId?: string) => {
      const out = await call(USER, queue.provide(startSyncRound({ portfolioId, auto })));
      if (out.round == null) throw new Error("start returned no round");
      return { opened: out.opened, round: out.round };
    };

    const consumeAll = async () => {
      for (const job of queue.syncJobs()) {
        expect(await consumeJob(job)).toEqual({ acked: true, retried: false });
      }
    };

    beforeEach(() => {
      outbound = blockOutbound();
      queue = captureQueue();
    });

    it("opening enqueues: one sync-account per account + one reference-layer set per user, no upstream calls", async () => {
      const a = await cex("Binance spot");
      const b = await cex("Kraken");

      const { round, opened } = await start();

      expect(opened).toBe(true);
      expect(outbound.calls).toEqual([]);
      expect(
        queue
          .syncJobs()
          .map((j) => j.accountId)
          .sort(),
      ).toEqual([a.id, b.id].sort());
      for (const job of queue.syncJobs()) {
        expect(job).toMatchObject({
          userId: USER,
          portfolioId: round.portfolioId,
          roundId: round.roundId,
        });
      }
      // The tail work of a manual sync is one message each, with the same delay rules as cron.
      expect(
        queue.sent
          .filter((m) => m.job.kind !== "sync-account")
          .map((m) => [m.job.kind, m.delaySeconds !== undefined]),
      ).toEqual([
        ["prices", false],
        ["daily-prices", false],
        ["fx", false],
        ["platforms", true],
        ["defi-logos", true],
      ]);
      // The reply is the current state: running, nothing recorded yet.
      expect(round.finishedAt).toBeNull();
      expect(Object.values(round.accounts).map((x) => x.status)).toEqual(["pending", "pending"]);
    });

    it("after consuming those messages -> recorded one by one, three tiers split correctly, the last one closes out", async () => {
      const willFail = await cex("Binance spot");
      const noKeys = await db(USER).accounts.create({
        connectorId: "binance",
        label: "No key yet",
        creds: null,
      });

      const { round } = await start();
      await consumeAll();

      const view = await read(round.portfolioId);
      expect(view?.state).toBe("done");
      expect(view?.settled).toBe(2);
      expect(view?.needsKeys).toBe(1);
      expect(view?.failed.map((f) => f.accountId)).toEqual([willFail.id]);
      // The upstream's own words are kept as is; the panel row doesn't translate them.
      expect(view?.failed[0]?.error).toBeTruthy();
      expect(view?.synced).toBe(0);
      expect(view?.statuses).toEqual({ [willFail.id]: "failed", [noKeys.id]: "needs-keys" });
      // A per-account failure isn't "the whole round failed to start", so that field must stay empty.
      expect(view?.error).toBeNull();
    });

    // A second device clicks sync / a double click: it gets back the same round and no second batch of messages is enqueued, or two
    // consumers would hit the upstream for the same accounts.
    it("live round still there -> returned as is, no more messages enqueued", async () => {
      await cex("Binance spot");
      const first = await start();
      const sentBefore = queue.sent.length;

      const second = await start();

      expect(second.opened).toBe(false);
      expect(second.round.roundId).toBe(first.round.roundId);
      expect(queue.sent).toHaveLength(sentBefore);
    });

    // A live round holds only one account (another device added accounts / clicked sync in the detail sidebar): the manual / automatic round
    // mustn't just yield, or the rest are missed. Same path as cron: pull the missing ones into that round and enqueue only them.
    it("a live round holds only one account -> pull the rest into that round and enqueue only them", async () => {
      const busy = await cex("Syncing alone");
      const other = await cex("The rest");
      const pf = await db(USER).portfolios.ensureDefault();
      await db(USER).syncRounds.open({
        portfolioId: pf.id,
        roundId: "single",
        trigger: "manual",
        accounts: [{ id: busy.id, label: busy.label }],
        ttlMs: ROUND_HEARTBEAT_MS,
      });

      const { opened, round } = await start();

      expect(opened).toBe(false);
      expect(round.roundId).toBe("single");
      // The reply is the current state: the pulled-in one is already on the list.
      expect(round.accounts[other.id]?.status).toBe("pending");
      expect(round.accounts[busy.id]?.status).toBe("pending");
      expect(queue.syncJobs().map((j) => [j.roundId, j.accountId])).toEqual([["single", other.id]]);
    });

    it("automatic round hits a single-account round -> pulled-in ones just synced are recorded skipped, not enqueued", async () => {
      const busy = await cex("Syncing alone");
      const fresh = await cex("Just synced");
      const stale = await cex("Long unsynced");
      await db(USER).snapshots.write(fresh.id, { takenAt: Date.now(), totalUsd: 1, balances: [] });
      const pf = await db(USER).portfolios.ensureDefault();
      await db(USER).syncRounds.open({
        portfolioId: pf.id,
        roundId: "single",
        trigger: "manual",
        accounts: [{ id: busy.id, label: busy.label }],
        ttlMs: ROUND_HEARTBEAT_MS,
      });

      const { round } = await start(true);

      expect(round.roundId).toBe("single");
      expect(round.accounts[fresh.id]?.status).toBe("skipped");
      expect(round.accounts[busy.id]?.status).toBe("pending");
      expect(queue.syncJobs().map((j) => j.accountId)).toEqual([stale.id]);
    });

    it("hits a single-account round and enqueue fails -> pulled-in ones recorded failed, that account's own is untouched", async () => {
      const busy = await cex("Syncing alone");
      const other = await cex("The rest");
      const pf = await db(USER).portfolios.ensureDefault();
      await db(USER).syncRounds.open({
        portfolioId: pf.id,
        roundId: "single",
        trigger: "manual",
        accounts: [{ id: busy.id, label: busy.label }],
        ttlMs: ROUND_HEARTBEAT_MS,
      });

      const exit = await call(
        USER,
        Effect.exit(
          startSyncRound({ auto: false }).pipe(
            Effect.provideService(JobQueue, {
              poke: Effect.void,
              send: () => Effect.die(new Error("queue down")),
            }),
          ),
        ),
      );

      expect(exit._tag).toBe("Failure");
      const back = Option.getOrNull(await db(USER).syncRounds.get(pf.id));
      expect(back?.roundId).toBe("single");
      expect(back?.accounts[other.id]?.status).toBe("failed");
      expect(back?.accounts[busy.id]?.status).toBe("pending");
      expect(back?.finishedAt).toBeNull();
    });

    it("empty portfolio -> closes out on the spot, no message enqueued", async () => {
      await manual("Manual");
      const { round } = await start();
      expect(round.finishedAt).not.toBeNull();
      expect(queue.sent).toEqual([]);
    });

    // The automatic round skips by freshness: an account with a snapshot within 1 hour is closed as skipped with **no message**;
    // ones without a snapshot enqueue as usual (outbound is cut in the consumer -> failure). The manual round never skips and forces everything.
    it("automatic round skips just-synced accounts; manual round forces all", async () => {
      const fresh = await cex("Just synced");
      const stale = await cex("Long unsynced");
      await db(USER).snapshots.write(fresh.id, {
        takenAt: Date.now(),
        totalUsd: 100,
        balances: [],
      });

      const auto = await start(true);
      // The reply already reflects the plan: the fresh cell is skipped.
      expect(auto.round.accounts[fresh.id]?.status).toBe("skipped");
      expect(queue.syncJobs().map((j) => j.accountId)).toEqual([stale.id]);
      await consumeAll();
      const autoView = await read(auto.round.portfolioId);
      expect(autoView?.state).toBe("done");
      expect(autoView?.skipped).toBe(1);
      expect(autoView?.failed.map((f) => f.accountId)).toEqual([stale.id]);

      queue = captureQueue();
      const manualRound = await start(); // the previous round closed out, so one can open
      expect(manualRound.opened).toBe(true);
      expect(
        queue
          .syncJobs()
          .map((j) => j.accountId)
          .sort(),
      ).toEqual([fresh.id, stale.id].sort());
      expect(outbound.calls).toEqual([]);
    });

    // A future timestamp (clock skew) counts as fresh; all fresh -> no message to enqueue -> closes out on the spot, no reference-layer jobs either.
    it("automatic round with everything fresh -> closes out on the spot, no message enqueued", async () => {
      const future = await cex("Clock skewed to future");
      await db(USER).snapshots.write(future.id, {
        takenAt: Date.now() + 60 * 60 * 1000,
        totalUsd: 100,
        balances: [],
      });

      const { round } = await start(true);

      expect(round.finishedAt).not.toBeNull();
      expect(round.accounts[future.id]?.status).toBe("skipped");
      expect(queue.sent).toEqual([]);
    });

    // A message from the previous round that reaches the consumer after the new round opened: its writes fall through and the new round isn't corrupted.
    it("a previous round's message can't write into the new round", async () => {
      await cex("Binance spot");
      const stale = await start();
      const staleJobs = queue.syncJobs();
      await db(USER).syncRounds.finish({
        portfolioId: stale.round.portfolioId,
        roundId: stale.round.roundId,
        retentionMs: 1_000,
      });
      const fresh = await start();
      expect(fresh.opened).toBe(true);

      for (const job of staleJobs) await consumeJob(job);

      const view = await read(fresh.round.portfolioId);
      expect(view?.roundId).toBe(fresh.round.roundId);
      expect(view?.settled).toBe(0);
      expect(view?.state).toBe("running");
    });

    // Enqueue blew up: don't leave the panel waiting 120s on a "running" round nobody will run: close out with a message, then fail the request.
    it("enqueue failure -> the round closes out with a message, the request fails", async () => {
      await cex("Binance spot");
      const exit = await call(
        USER,
        Effect.exit(
          startSyncRound({ auto: false }).pipe(
            Effect.provideService(JobQueue, {
              poke: Effect.void,
              send: () => Effect.die(new Error("queue down")),
            }),
          ),
        ),
      );
      expect(exit._tag).toBe("Failure");
      const pf = await db(USER).portfolios.ensureDefault();
      const round = Option.getOrNull(await db(USER).syncRounds.get(pf.id));
      expect(round?.finishedAt).not.toBeNull();
      expect(round?.error).toBeTruthy();
    });
  });
});
