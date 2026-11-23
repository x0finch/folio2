import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { runForUser } from "@/lib/server/runtime";
import { startSyncRound } from "@/lib/server/sync/round";
import { handleSyncAccount, SyncAccountInput, type SyncAccountStart } from "@/lib/server/sync/run";
import { db } from "../_kit/db";
import { blockOutbound, json, stubOutbound } from "../_kit/outbound";
import { captureQueue, consumeJob } from "../_kit/queue";
import { seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

describe("sync/run", () => {
  // The messages it enqueues carry a userId, filled by the assembly point via `enqueueForUser`; the handler takes no userId.
  // This runs the kernel `runForUser` beneath `runEffect`, with delivery swapped for a fake queue (`captureQueue`) collecting into an array.
  const USER = "h-sync-run";
  let queue: ReturnType<typeof captureQueue>;

  const run = <A, E, R>(userId: string, effect: Effect.Effect<A, E, R>) =>
    // biome-ignore lint/suspicious/noExplicitAny: same shape as the production assembly point; the kernel fills in the handler's R
    runForUser(userId, queue.provide(effect) as any) as Promise<A>;

  const exitOf = <A, E, R>(userId: string, effect: Effect.Effect<A, E, R>) =>
    run(userId, Effect.exit(effect));

  beforeEach(async () => {
    blockOutbound();
    queue = captureQueue();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("syncAccount", () => {
    it('manual account -> skipped, reason "no upstream", no outbound call at all', async () => {
      const outbound = blockOutbound();
      const acc = await seedManualAccount(USER, "Manual", {
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      });

      const out = await run(USER, handleSyncAccount({ accountId: acc.id }));

      expect(out).toEqual({
        queued: false,
        result: { accountId: acc.id, ok: false, skipped: true, skipReason: "manual" },
      });
      expect(outbound.calls).toEqual([]);
      expect(queue.sent).toEqual([]);
    });

    it("account doesn't exist -> NotFound, no request sent", async () => {
      const outbound = blockOutbound();

      const exit = await exitOf(USER, handleSyncAccount({ accountId: "no-such-account" }));

      expect(exit._tag).toBe("Failure");
      expect(outbound.calls).toEqual([]);
    });

    it("account belongs to someone else -> NotFound, no request sent", async () => {
      const outbound = blockOutbound();
      const theirs = await seedManualAccount(otherUser(USER), "Theirs", {
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      });

      const exit = await exitOf(USER, handleSyncAccount({ accountId: theirs.id }));

      expect(exit._tag).toBe("Failure");
      expect(outbound.calls).toEqual([]);
    });

    it('CEX account with incomplete credentials -> skipped, reason "credentials not filled in", distinguishable from a manual account', async () => {
      // Both are skipped but only this one has a next action (finish the credentials), so the UI must tell them apart.
      const acc = await db(USER).accounts.create({
        connectorId: "binance",
        label: "Binance",
        creds: JSON.stringify({ apiKey: "only half" }),
      });

      const out = await run(USER, handleSyncAccount({ accountId: acc.id }));

      expect(out).toEqual({
        queued: false,
        result: {
          accountId: acc.id,
          ok: false,
          skipped: true,
          skipReason: "missing-credentials",
        },
      });
    });

    it("incomplete credentials -> no upstream call, no message enqueued", async () => {
      // Answerable on the spot, so it isn't even queued: not worth a message or an invocation.
      const outbound = blockOutbound();
      const acc = await db(USER).accounts.create({
        connectorId: "binance",
        label: "Binance",
        creds: JSON.stringify({ apiKey: "only half" }),
      });

      await run(USER, handleSyncAccount({ accountId: acc.id }));

      expect(outbound.calls).toEqual([]);
      expect(queue.sent).toEqual([]);
    });

    // -- queued into a round, one message enqueued, returns at once --

    const cex = (label: string) =>
      db(USER).accounts.create({
        connectorId: "binance",
        label,
        creds: JSON.stringify({ apiKey: "k", secret: "s" }),
      });

    const queued = async (accountId: string) => {
      const out: SyncAccountStart = await run(USER, handleSyncAccount({ accountId }));
      if (!out.queued) throw new Error(`expected a queued sync, got ${JSON.stringify(out)}`);
      return out;
    };

    it("account with full credentials -> opens a round holding only it, enqueues one sync-account + the reference-layer jobs; no upstream calls", async () => {
      const outbound = blockOutbound();
      await cex("Other account");
      const acc = await cex("Binance");

      const out = await queued(acc.id);

      expect(outbound.calls).toEqual([]);
      const def = await db(USER).portfolios.ensureDefault();
      expect(out.portfolioId).toBe(def.id);
      expect(out.round.state).toBe("running");
      expect(out.round.statuses).toEqual({ [acc.id]: "pending" });
      expect(queue.syncJobs()).toEqual([
        {
          kind: "sync-account",
          userId: USER,
          portfolioId: def.id,
          roundId: out.roundId,
          accountId: acc.id,
        },
      ]);
      expect(queue.sent.map((m) => m.job.kind)).toEqual([
        "sync-account",
        "prices",
        "daily-prices",
        "fx",
        "platforms",
        "defi-logos",
      ]);
    });

    it("consuming that message -> this account is recorded and the round finishes (the frontend waits on this cell)", async () => {
      const acc = await cex("Binance");
      const out = await queued(acc.id);

      const [job] = queue.syncJobs();
      expect(await consumeJob(job)).toEqual({ acked: true, retried: false });

      const round = Option.getOrNull(await db(USER).syncRounds.get(out.portfolioId));
      expect(round?.roundId).toBe(out.roundId);
      expect(round?.accounts[acc.id]?.status).toBe("failed"); // outbound cut off
      expect(round?.finishedAt).not.toBeNull();
    });

    it("account in another portfolio -> queued into that portfolio's round", async () => {
      const watch = await db(USER).portfolios.create({ name: "Watchlist" });
      const acc = await cex("In watchlist");
      await db(USER).portfolios.assignAccount(acc.id, watch.id);

      const out = await queued(acc.id);

      expect(out.portfolioId).toBe(watch.id);
      expect(queue.syncJobs()[0]?.portfolioId).toBe(watch.id);
    });

    // A round is already running for the same portfolio (another device clicked full sync, cron just opened one): don't overwrite it, pull this account in.
    it("hits a live round -> pulled into that round (accounts outside the list are added), no second round opened", async () => {
      await cex("Already in round");
      const full = await run(USER, startSyncRound({ auto: false }));
      if (!full.round) throw new Error("no round");
      const late = await cex("Added after round opened");
      queue = captureQueue();

      const out = await queued(late.id);

      expect(out.roundId).toBe(full.round.roundId);
      expect(Object.keys(out.round.statuses)).toHaveLength(2);
      expect(out.round.statuses[late.id]).toBe("pending");
      expect(queue.syncJobs().map((j) => [j.roundId, j.accountId])).toEqual([
        [full.round.roundId, late.id],
      ]);
    });

    // Idempotent: a double click (or a manual hit colliding with cron's) -> two messages for one account, but synced only once.
    it("same account enqueued twice -> the first message syncs and records, the second is a no-op (no outbound, no rewrite)", async () => {
      const BTC_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
      const acc = await db(USER).accounts.create({
        connectorId: "bitcoin",
        label: "cold",
        creds: JSON.stringify({ addressOrXpub: BTC_ADDRESS }),
      });
      const first = await queued(acc.id);
      const second = await queued(acc.id);
      expect(second.roundId).toBe(first.roundId);
      const [a, b] = queue.syncJobs();
      expect(b).toEqual(a);

      const outbound = stubOutbound([
        [
          "/api/v2/address/",
          () => json({ address: BTC_ADDRESS, balance: "150000000", unconfirmedBalance: "0" }),
        ],
      ]);
      await consumeJob(a);
      const afterFirst = outbound.calls.length;
      expect(afterFirst).toBeGreaterThan(0);
      await consumeJob(b);
      expect(outbound.calls.length).toBe(afterFirst);

      const round = Option.getOrNull(await db(USER).syncRounds.get(first.portfolioId));
      expect(round?.accounts[acc.id]?.status).toBe("synced");
      const latest = await db(USER).snapshots.latest();
      expect(latest.map((s) => s.snapshot.accountId)).toEqual([acc.id]);
    });

    it("empty accountId -> rejected by schema", () => {
      expect(SyncAccountInput.safeParse({ accountId: "" }).success).toBe(false);
    });
  });
});
