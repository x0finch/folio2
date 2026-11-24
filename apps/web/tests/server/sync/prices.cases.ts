import { Oracle } from "@folio/oracle";
import { Effect, Result } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICES_IDS_PER_MESSAGE } from "@/lib/server/jobs/constants";
import { consumeMessage, type JobMessage } from "@/lib/server/jobs/consume";
import { decodeJob, type Job } from "@/lib/server/jobs/message";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { db } from "../_kit/db";
import { blockOutbound, json } from "../_kit/outbound";
import { call } from "../_kit/run";
import { seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser } from "../_kit/user";

// The queue's `prices` job, where held-token prices are fetched: batches of 100, at most 1000 ids per message.
// Outbound is counted on real fetches (the CoinGecko adapter really does the batching), not on fake upstream method calls.

/** Free-plan cap on external subrequests per invocation; one message = one invocation. */
const FREE_PLAN_SUBREQUESTS = 50;

describe("jobs/prices", () => {
  const USER = "h-jobs-prices";

  /** Runs one message and collects the follow-up messages it enqueues. */
  const consume = async (body: Job) => {
    const sent: Enqueued[] = [];
    const state = { acked: false, retried: false };
    const message: JobMessage = {
      id: `m-${Math.random()}`,
      body,
      attempts: 1,
      ack: () => {
        state.acked = true;
      },
      retry: () => {
        state.retried = true;
      },
    };
    await Effect.runPromise(
      consumeMessage(message).pipe(
        Effect.provideService(JobQueue, {
          poke: Effect.void,
          send: (batch) => Effect.sync(() => void sent.push(...batch)),
        }),
      ),
    );
    return { state, sent };
  };

  /** Builds n recognized coins (CoinGecko refs) that appear in the latest snapshot -- that is "held". */
  const hold = async (n: number): Promise<string[]> => {
    const refs = Array.from({ length: n }, (_, i) => `coingecko/issued:coin-${i}`);
    const ids = await call(
      USER,
      Effect.flatMap(Oracle, (o) =>
        o.tokens.mint(refs.map((ref, i) => ({ ref, seed: { symbol: `C${i}` } }))),
      ),
    );
    const tokenIds = refs.map((r) => ids.get(r)).filter((id) => id !== undefined);
    expect(tokenIds).toHaveLength(n);
    const acc = await seedAccount(USER, "w", "bitcoin");
    await seedSnapshot(
      USER,
      acc.id,
      Date.now(),
      tokenIds.map((tokenId) => ({ tokenId, amount: 1, usdValue: 10 })),
    );
    return tokenIds;
  };

  // Gives every asked coin id a price; `/coins/markets` (the metadata half) gets an empty list. `stubOutbound` only does
  // "fragment -> fixed response" but this must answer per the ids in the URL, so it spies itself.
  // `failFirst`: the first k calls to the same URL answer 503 (retryable) and the (k+1)th succeeds, so each adapter call uses up
  // its retries before succeeding: the worst-case outbound count of one message. `Infinity` = always down.
  const pricedUpstream = (opts: { failFirst?: number } = {}): { calls: string[] } => {
    const calls: string[] = [];
    const seen = new Map<string, number>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const tries = (seen.get(url) ?? 0) + 1;
      seen.set(url, tries);
      if (tries <= (opts.failFirst ?? 0)) return json({ error: "down" }, 503);
      const u = new URL(url);
      if (u.pathname.endsWith("/simple/price")) {
        const ids = (u.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        return json(
          Object.fromEntries(ids.map((id) => [id, { usd: 2, last_updated_at: 1_700_000_000 }])),
        );
      }
      if (u.pathname.endsWith("/coins/markets")) return json([]);
      throw new Error(`no answer prepared for this URL: ${url}`);
    });
    return { calls };
  };

  const count = (calls: readonly string[], path: string) =>
    calls.filter((u) => new URL(u).pathname.endsWith(path)).length;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await db(USER).portfolios.ensureDefault();
  });

  it("250 held coins -> 3 price calls (batches of 100), written to the price table; nothing enqueued further", async () => {
    const tokenIds = await hold(250);
    const outbound = pricedUpstream();

    const { state, sent } = await consume({ kind: "prices", userId: USER });

    expect(state).toEqual({ acked: true, retried: false });
    expect(count(outbound.calls, "/simple/price")).toBe(3);
    expect(outbound.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    expect(sent).toEqual([]);
    const priced = await call(
      USER,
      Effect.flatMap(Oracle, (o) => o.tokens.pricesOf(tokenIds)),
    );
    expect(priced.size).toBe(250);
    expect([...priced.values()].every((p) => p.unitPrice === 2 && !p.stale)).toBe(true);

    // Just refreshed -> all fresh; running again makes zero outbound calls (redelivery is free).
    const again = pricedUpstream();
    await consume({ kind: "prices", userId: USER });
    expect(count(again.calls, "/simple/price")).toBe(0);
  });

  it("over one message's budget -> refreshes the first 1000 itself, enqueues the rest in chunks; each message <= 50 calls", async () => {
    const n = PRICES_IDS_PER_MESSAGE + 200;
    const tokenIds = await hold(n);
    const first = pricedUpstream();

    const { sent } = await consume({ kind: "prices", userId: USER });

    expect(count(first.calls, "/simple/price")).toBe(PRICES_IDS_PER_MESSAGE / 100);
    expect(first.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    expect(sent).toHaveLength(1);
    const [follow] = sent;
    if (follow?.job.kind !== "prices" || !follow.job.tokenIds) throw new Error("no follow-up");
    expect(follow.job.tokenIds).toHaveLength(200);
    // The enqueued messages pass their own schema (the consumer side can decode them).
    expect(Result.isSuccess(decodeJob(follow.job))).toBe(true);

    const second = pricedUpstream();
    const tail = await consume(follow.job);
    expect(tail.sent).toEqual([]); // the chunk-carrying message enqueues nothing further
    expect(count(second.calls, "/simple/price")).toBe(2);

    const priced = await call(
      USER,
      Effect.flatMap(Oracle, (o) => o.tokens.pricesOf(tokenIds)),
    );
    expect(priced.size).toBe(n);
    // Building 1200 coin rows + snapshots in workerd's D1 takes seconds; the code under test isn't slow.
  }, 30_000);

  // The cases above never fail upstream, so the budget derivation's "x attempts" is never exercised. This one makes every call
  // use up its retries: first measure with an always-down upstream how many attempts the adapter makes (how many times one URL is hit),
  // then fail each URL's first (N - 1) attempts and succeed on the Nth. 1000 coins -> (10 + 10) x N calls; if the adapter's attempt
  // count is raised this goes over 50 and fails, instead of staying green like a happy-path-only test.
  it("worst case (every call uses up its retries) -> one message still <= 50 calls", async () => {
    await hold(PRICES_IDS_PER_MESSAGE);

    const down = pricedUpstream({ failFirst: Number.POSITIVE_INFINITY });
    const probe = await consume({ kind: "prices", userId: USER });
    expect(probe.state).toEqual({ acked: true, retried: false }); // upstream down isn't a message failure
    const [firstUrl] = down.calls;
    const attempts = down.calls.filter((u) => u === firstUrl).length;
    expect(attempts).toBeGreaterThan(1); // really retrying (otherwise this can't test what it means to)

    const flaky = pricedUpstream({ failFirst: attempts - 1 });
    const { state, sent } = await consume({ kind: "prices", userId: USER });
    expect(state).toEqual({ acked: true, retried: false });
    expect(sent).toEqual([]);
    const batches = PRICES_IDS_PER_MESSAGE / 100;
    expect(count(flaky.calls, "/simple/price")).toBe(batches * attempts);
    expect(count(flaky.calls, "/coins/markets")).toBe(batches * attempts);
    expect(flaky.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    // Building 1000 coin rows + a real wait for each call's backoff (from 250ms).
  }, 60_000);

  it("no holdings -> no calls at all, still acks", async () => {
    const outbound = blockOutbound();
    const { state } = await consume({ kind: "prices", userId: USER });
    expect(state).toEqual({ acked: true, retried: false });
    expect(outbound.calls).toEqual([]);
  });

  it("a chunk over budget is rejected at decode (can't run to 50+ calls)", () => {
    const ids = (k: number) => Array.from({ length: k }, (_, i) => `t${i}`);
    const body = (k: number) => ({ kind: "prices", userId: USER, tokenIds: ids(k) });
    expect(Result.isSuccess(decodeJob(body(PRICES_IDS_PER_MESSAGE)))).toBe(true);
    expect(Result.isFailure(decodeJob(body(PRICES_IDS_PER_MESSAGE + 1)))).toBe(true);
  });
});
