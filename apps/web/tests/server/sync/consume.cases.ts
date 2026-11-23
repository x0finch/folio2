import { Oracle } from "@folio/oracle";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_MAX_RETRIES } from "@/lib/server/jobs/constants";
import { consumeMessage, type JobMessage } from "@/lib/server/jobs/consume";
import type { SyncAccountJob } from "@/lib/server/jobs/message";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { fanOutAllUsers, ROUND_HEARTBEAT_MS } from "@/lib/server/sync/round";
import { db } from "../_kit/db";
import { blockOutbound, json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// Queue consumer: one `sync-account` = sync exactly that account, record it, the last one closes the round out. Messages come
// from the real fan-out (not hand-built), so what cron enqueues and what the consumer accepts share one shape.

/** Free-plan cap on external subrequests per invocation; one message = one invocation, so it is one message's outbound budget. */
const FREE_PLAN_SUBREQUESTS = 50;

// A well-formed BTC address (passes the connector's validation gate); balances are stubbed, so whose address it is doesn't matter.
const BTC_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

describe("jobs/consume", () => {
  const USER = "h-jobs-consume";

  const fakeMessage = (body: unknown, attempts = 1) => {
    const state = { acked: false, retried: false };
    const message: JobMessage = {
      id: `m-${Math.random()}`,
      body,
      attempts,
      ack: () => {
        state.acked = true;
      },
      retry: () => {
        state.retried = true;
      },
    };
    return { message, state };
  };

  const consume = (body: unknown, attempts = 1) => {
    const { message, state } = fakeMessage(body, attempts);
    return Effect.runPromise(consumeMessage(message)).then(() => state);
  };

  const fanOut = async (): Promise<SyncAccountJob[]> => {
    const sent: Enqueued[] = [];
    await Effect.runPromise(
      fanOutAllUsers([USER]).pipe(
        Effect.provideService(JobQueue, {
          poke: Effect.void,
          send: (batch) => Effect.sync(() => void sent.push(...batch)),
        }),
      ),
    );
    return sent.flatMap((m) => (m.job.kind === "sync-account" ? [m.job] : []));
  };

  const cex = (label: string) =>
    db(USER).accounts.create({
      connectorId: "binance",
      label,
      creds: JSON.stringify({ apiKey: "k", secret: "s" }),
    });

  const roundOf = async (portfolioId: string) =>
    Option.getOrNull(await db(USER).syncRounds.get(portfolioId));

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await db(USER).portfolios.ensureDefault();
  });

  it("records one by one, the last one closes out; every one acks", async () => {
    await cex("a");
    await cex("b");
    const jobs = await fanOut();
    expect(jobs).toHaveLength(2);
    const [first, second] = jobs as [SyncAccountJob, SyncAccountJob];

    expect(await consume(first)).toEqual({ acked: true, retried: false });
    const mid = await roundOf(first.portfolioId);
    // Outbound cut off -> this account fails, but as a recorded failure, not a queue retry.
    expect(mid?.accounts[first.accountId]?.status).toBe("failed");
    expect(mid?.accounts[second.accountId]?.status).toBe("pending");
    expect(mid?.finishedAt).toBeNull();

    expect(await consume(second)).toEqual({ acked: true, retried: false });
    const done = await roundOf(first.portfolioId);
    expect(done?.accounts[second.accountId]?.status).toBe("failed");
    expect(done?.finishedAt).not.toBeNull();
  });

  it("the successful one: writes the snapshot, records synced -- and one message's outbound stays within the free plan's 50 calls", async () => {
    const acc = await db(USER).accounts.create({
      connectorId: "bitcoin",
      label: "cold",
      creds: JSON.stringify({ addressOrXpub: BTC_ADDRESS }),
    });
    const [job] = await fanOut();
    if (!job) throw new Error("no job enqueued");
    // Only Blockbook has an answer; the rest (the prices valuation needs) still throw, and throwing calls count too since each spends a subrequest.
    const outbound = stubOutbound([
      [
        "/api/v2/address/",
        () => json({ address: BTC_ADDRESS, balance: "150000000", unconfirmedBalance: "0" }),
      ],
    ]);

    expect(await consume(job)).toEqual({ acked: true, retried: false });

    const round = await roundOf(job.portfolioId);
    expect(round?.accounts[acc.id]?.status).toBe("synced");
    expect(round?.finishedAt).not.toBeNull();
    const latest = await db(USER).snapshots.latest();
    expect(latest.map((s) => s.snapshot.accountId)).toEqual([acc.id]);
    expect(outbound.calls.length).toBeGreaterThan(0);
    expect(outbound.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    // Valuation reads only the price table: not one CoinGecko call (prices belong to the queue's `prices` job).
    expect(outbound.calls.filter((u) => u.includes("coingecko"))).toEqual([]);
  });

  // Revaluation uses the price table's prices (even stale ones) and doesn't go back to source.
  it("valuation uses prices already in the table, zero CoinGecko requests", async () => {
    await db(USER).accounts.create({
      connectorId: "bitcoin",
      label: "cold",
      creds: JSON.stringify({ addressOrXpub: BTC_ADDRESS }),
    });
    const [job] = await fanOut();
    if (!job) throw new Error("no job enqueued");
    // First get a BTC price into the table: mint the row, then write it via the real price-refresh path.
    const ids = await call(
      USER,
      Effect.flatMap(Oracle, (o) =>
        o.tokens.mint([{ ref: "bitcoin/native", seed: { symbol: "BTC" } }]),
      ),
    );
    const btc = ids.get("bitcoin/native");
    if (!btc) throw new Error("BTC not minted");
    stubOutbound([
      ["/simple/price", () => json({ bitcoin: { usd: 40_000, last_updated_at: 1_700_000_000 } })],
      ["/coins/markets", () => json([])],
    ]);
    await call(
      USER,
      Effect.flatMap(Oracle, (o) => o.tokens.refreshStale([btc])),
    );
    const priced = await call(
      USER,
      Effect.flatMap(Oracle, (o) => o.tokens.pricesOf([btc])),
    );
    expect(priced.get(btc)?.unitPrice).toBe(40_000);

    const outbound = stubOutbound([
      [
        "/api/v2/address/",
        () => json({ address: BTC_ADDRESS, balance: "150000000", unconfirmedBalance: "0" }),
      ],
    ]);
    expect(await consume(job)).toEqual({ acked: true, retried: false });

    expect(outbound.calls.filter((u) => u.includes("coingecko"))).toEqual([]);
    const [latest] = await db(USER).snapshots.latest();
    expect(latest?.snapshot.totalUsd).toBe(60_000); // 1.5 BTC x 40k from the table
  });

  // Worst case: the upstream is entirely unreachable and the core's retries are all used up; still one invocation's budget.
  // Blockbook amplifies the most: four public nodes rotating x the core's retries.
  it("upstream entirely down (retries used up) -> one message's outbound is still <= 50 calls", async () => {
    await db(USER).accounts.create({
      connectorId: "bitcoin",
      label: "cold",
      creds: JSON.stringify({ addressOrXpub: BTC_ADDRESS }),
    });
    const [job] = await fanOut();
    const outbound = blockOutbound();
    await consume(job);
    expect(outbound.calls.length).toBeGreaterThan(0);
    expect(outbound.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  });

  // at-least-once: the same message enqueued twice must not hit the upstream a second time.
  it("duplicate delivery / round already overwritten -> skipped, no outbound, still acks", async () => {
    await cex("a");
    const [job] = await fanOut();
    if (!job) throw new Error("no job enqueued");
    await consume(job);
    const outbound = blockOutbound();
    expect(await consume(job)).toEqual({ acked: true, retried: false });
    expect(await consume({ ...job, roundId: "some-older-round" })).toEqual({
      acked: true,
      retried: false,
    });
    expect(outbound.calls).toEqual([]);
  });

  it("account deleted while queued -> recorded skipped, the round still closes out", async () => {
    const acc = await cex("a");
    const [job] = await fanOut();
    if (!job) throw new Error("no job enqueued");
    await db(USER).accounts.remove(acc.id);
    await consume(job);
    const round = await roundOf(job.portfolioId);
    expect(round?.accounts[acc.id]?.status).toBe("skipped");
    expect(round?.finishedAt).not.toBeNull();
  });

  it("undecodable message -> acked and dropped, no retry", async () => {
    expect(await consume({ kind: "nope" })).toEqual({ acked: true, retried: false });
    expect(await consume("not even an object")).toEqual({ acked: true, retried: false });
    expect(await consume({ kind: "sync-account", userId: USER })).toEqual({
      acked: true,
      retried: false,
    });
  });

  describe("failed jobs", () => {
    const boom = () => Effect.fail(new Error("D1 hiccup"));

    it("retries remain -> retry, the account stays pending in the round", async () => {
      await cex("a");
      const [job] = await fanOut();
      if (!job) throw new Error("no job enqueued");
      const { message, state } = fakeMessage(job, 1);
      await Effect.runPromise(consumeMessage(message, boom));
      expect(state).toEqual({ acked: false, retried: true });
      expect((await roundOf(job.portfolioId))?.accounts[job.accountId]?.status).toBe("pending");
    });

    // Without wrap-up the account would stay pending forever and the panel would wait for the heartbeat to expire before saying "interrupted". After wrap-up it still calls retry()
    // (attempts exhausted; the runner buries it accordingly, see tests/job-runner.test.ts): a failed job must be visible.
    it("last delivery still fails -> recorded failed, round closes out, then retry() hands it to the runner to bury (no ack)", async () => {
      await cex("a");
      const [job] = await fanOut();
      if (!job) throw new Error("no job enqueued");
      const { message, state } = fakeMessage(job, JOB_MAX_RETRIES + 1);
      await Effect.runPromise(consumeMessage(message, boom));
      expect(state).toEqual({ acked: false, retried: true });
      const round = await roundOf(job.portfolioId);
      expect(round?.accounts[job.accountId]?.status).toBe("failed");
      expect(round?.accounts[job.accountId]?.error).toContain("D1 hiccup");
      expect(round?.finishedAt).not.toBeNull();
    });

    // Jobs like price refresh have no wrap-up, but a final failure must still be buried and visible, not acked into a mere log line.
    it("a job without wrap-up fails the last time -> also retry() (handed to the runner to bury)", async () => {
      const { message, state } = fakeMessage({ kind: "prices", userId: USER }, JOB_MAX_RETRIES + 1);
      await Effect.runPromise(consumeMessage(message, boom));
      expect(state).toEqual({ acked: false, retried: true });
    });

    // If the buried one is dug up and rerun: wrap-up already recorded the account failed, the "still pending?" check stops it, no outbound.
    it("a buried sync-account delivered again -> no-op, no outbound, no rewrite", async () => {
      await cex("a");
      const [job] = await fanOut();
      if (!job) throw new Error("no job enqueued");
      await Effect.runPromise(consumeMessage(fakeMessage(job, JOB_MAX_RETRIES + 1).message, boom));
      const outbound = blockOutbound();
      expect(await consume(job)).toEqual({ acked: true, retried: false });
      expect(outbound.calls).toEqual([]);
      expect((await roundOf(job.portfolioId))?.accounts[job.accountId]?.error).toContain(
        "D1 hiccup",
      );
    });
  });

  // Two deliveries running at the same time (at-least-once redelivery, enlist of an already-pending account): the upstream call hangs
  // until both have entered the sync (both passed the "still pending?" check), then both are released together.
  const gatedBlockbook = (inFlightTarget: number) => {
    let inFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Safety net: if the other one never enters (stopped by the "still pending?" check), don't hang the case; the assertion reports it after release.
    const timer = setTimeout(() => release(), 5_000);
    const reached = { max: 0 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("/api/v2/address/"))
        throw new Error(`no answer prepared for this URL: ${url}`);
      inFlight++;
      reached.max = Math.max(reached.max, inFlight);
      if (inFlight >= inFlightTarget) release();
      await gate;
      clearTimeout(timer);
      return json({ address: BTC_ADDRESS, balance: "150000000", unconfirmedBalance: "0" });
    });
    return { reached, release };
  };

  const bitcoin = () =>
    db(USER).accounts.create({
      connectorId: "bitcoin",
      label: "cold",
      creds: JSON.stringify({ addressOrXpub: BTC_ADDRESS }),
    });

  // The later settle must only act on pending -> terminal and leave the closed-out round untouched (e.g. the 7-day retention written at
  // close-out must not be reverted to 120 seconds, nor the status taken from the later one).
  it("two concurrent deliveries for one account -> both run, but recorded once; the closed-out round's retention isn't shortened", async () => {
    await bitcoin();
    const [job] = await fanOut();
    if (!job) throw new Error("no job enqueued");
    const gate = gatedBlockbook(2);

    const [a, b] = await Promise.all([consume(job), consume(job)]);

    expect(gate.reached.max).toBe(2); // both passed the "still pending?" check
    expect(a).toEqual({ acked: true, retried: false });
    expect(b).toEqual({ acked: true, retried: false });
    const round = await roundOf(job.portfolioId);
    expect(round?.accounts[job.accountId]?.status).toBe("synced");
    expect(round?.finishedAt).not.toBeNull();
    expect(round?.expiresAt).toBeGreaterThan(Date.now() + ROUND_HEARTBEAT_MS);
  });

  // No recording happens between redeliveries and the heartbeat is renewed only just before the consumer starts: while the upstream hangs,
  // check it is already renewed to now + ROUND_HEARTBEAT_MS, not still at the moment the round opened.
  it('heartbeat renewed before each delivery starts -- a round on a redelivery chain isn\'t read as "interrupted" early', async () => {
    await bitcoin();
    await cex("Another"); // so the round isn't closed out after this one records
    const jobs = await fanOut();
    const btcJob = (
      await Promise.all(
        jobs.map(async (j) => ({ j, a: await db(USER).accounts.getById(j.accountId) })),
      )
    ).find((x) => x.a?.connectorId === "bitcoin")?.j;
    if (!btcJob) throw new Error("no bitcoin job");
    // Simulates "the previous delivery ended as a defect, a redelivery interval passed": only 1 second of heartbeat left.
    await db(USER).syncRounds.touch({
      portfolioId: btcJob.portfolioId,
      roundId: btcJob.roundId,
      ttlMs: 1_000,
    });
    const gate = gatedBlockbook(1);
    const running = consume(btcJob);
    // Waiting for the upstream call to really hang (past the pre-start step) before reading.
    while (gate.reached.max < 1) await new Promise((r) => setTimeout(r, 5));
    const seen = (await roundOf(btcJob.portfolioId))?.expiresAt;
    gate.release();
    await running;

    expect(seen).toBeGreaterThan(Date.now() + ROUND_HEARTBEAT_MS - 10_000);
  });
});
