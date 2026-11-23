import { FIAT_NAMER, MS_PER_DAY, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { Effect, Either } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCreateAccountAndRefill } from "@/lib/server/accounts/create";
import { handleGetAccountHistory } from "@/lib/server/accounts/history";
import {
  DAILY_PRICES_CALLS_PER_MESSAGE,
  DAILY_PRICES_UPSTREAM_CALLS,
} from "@/lib/server/jobs/constants";
import { consumeMessage, type JobMessage } from "@/lib/server/jobs/consume";
import { decodeJob, type Job } from "@/lib/server/jobs/message";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { loadManualAccountSeries } from "@/lib/server/manual/store";
import { handleCreateManualActivitiesAndRefill } from "@/lib/server/manual-activities/create";
import { handleUpdateManualActivityAndRefill } from "@/lib/server/manual-activities/update";
import { handleGetPortfolioHistory } from "@/lib/server/portfolio/get-history";
import { handleGetSnapshots } from "@/lib/server/portfolio/snapshots";
import { db } from "../_kit/db";
import { fakeRegistry } from "../_kit/fakes";
import { blockOutbound, json } from "../_kit/outbound";
import { captureQueue } from "../_kit/queue";
import { call, callWithRegistry } from "../_kit/run";
import { freshUser } from "../_kit/user";
import { oracleDbFor } from "../db-effect";
import { ticketOf } from "../ticket";

// The queue's `daily-prices` job, where the manual history curve's daily prices are fetched: one message within budget; the three
// chart-reading endpoints only read the table. Outbound is counted on real fetches (the CoinGecko adapter really sends range requests).

/** Free-plan cap on external subrequests per invocation; one message = one invocation. */
const FREE_PLAN_SUBREQUESTS = 50;
const YEARS_3 = 3 * 365;

describe("jobs/daily-prices", () => {
  const USER = "h-jobs-daily-prices";

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

  // `/coins/{id}/market_chart/range`: one point per UTC day start in the range (coin price = 100, BTC's EUR price = 80).
  // `failFirst`: the first k calls to the same URL answer 503 (retryable), then it succeeds; see the worst-case case.
  const rangeUpstream = (
    opts: { fail?: boolean; failFirst?: number } = {},
  ): { calls: string[] } => {
    const calls: string[] = [];
    const seen = new Map<string, number>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const u = new URL(url);
      if (!u.pathname.endsWith("/market_chart/range")) {
        throw new Error(`no answer prepared for this URL: ${url}`);
      }
      const tries = (seen.get(url) ?? 0) + 1;
      seen.set(url, tries);
      if (opts.fail || tries <= (opts.failFirst ?? 0)) return json({ error: "down" }, 503);
      const fromMs = Number(u.searchParams.get("from")) * 1000;
      const toMs = Number(u.searchParams.get("to")) * 1000;
      const price = u.searchParams.get("vs_currency") === "eur" ? 80 : 100;
      const prices: [number, number][] = [];
      for (let t = Math.ceil(fromMs / MS_PER_DAY) * MS_PER_DAY; t <= toMs; t += MS_PER_DAY) {
        prices.push([t, price]);
      }
      return json({ prices });
    });
    return { calls };
  };

  const rangeCalls = (calls: readonly string[]) =>
    calls.filter((u) => new URL(u).pathname.endsWith("/market_chart/range")).length;

  const eurCash = {
    symbol: "EUR",
    unitPrice: 1.1,
    ticket: tokenTicket.encode(tokenRef.issued(FIAT_NAMER, "EUR")),
  };

  /**
   * A manual account with three recognized coins + EUR cash, first activity `daysAgo` days back. `coins` / `cash` are swappable:
   * the daily price table is global and not cleared per user, so cases measuring real fetches must use coins only they use.
   */
  const manualAccount = async (
    daysAgo: number,
    { coins = ["bitcoin", "ethereum", "solana"], cash = true } = {},
  ) => {
    const account = await db(USER).accounts.create({
      connectorId: "manual",
      label: "M",
      creds: JSON.stringify({ tokens: "[]" }),
    });
    const at = Date.now() - daysAgo * MS_PER_DAY;
    const queue = captureQueue();
    await call(
      USER,
      queue.provide(
        handleCreateManualActivitiesAndRefill({
          accountId: account.id,
          drafts: [
            ...coins.map((coin) => ({
              token: {
                symbol: coin.slice(0, 3).toUpperCase(),
                unitPrice: 1,
                ticket: ticketOf(coin),
              },
              kind: "add" as const,
              amount: 1,
              occurredAt: at,
              price: 1,
            })),
            ...(cash
              ? [{ token: eurCash, kind: "set" as const, amount: 100, occurredAt: at, price: 1.1 }]
              : []),
          ],
        }),
      ),
    );
    return { account, queue };
  };

  /** Runs a message and its follow-ups to completion, returning each message's real fetch count. */
  const drain = async (first: Job) => {
    const perMessage: number[] = [];
    const queue: Job[] = [first];
    while (queue.length > 0) {
      const job = queue.shift() as Job;
      const outbound = rangeUpstream();
      const { state, sent } = await consume(job);
      expect(state).toEqual({ acked: true, retried: false });
      perMessage.push(outbound.calls.length);
      for (const m of sent) {
        expect(Either.isRight(decodeJob(m.job))).toBe(true);
        queue.push(m.job);
      }
      expect(perMessage.length).toBeLessThan(20); // the relay chain must converge
    }
    return perMessage;
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await db(USER).portfolios.ensureDefault();
  });

  it("no manual account -> zero outbound, nothing enqueued further", async () => {
    const outbound = rangeUpstream();
    const { state, sent } = await consume({ kind: "daily-prices", userId: USER });
    expect(state).toEqual({ acked: true, retried: false });
    expect(outbound.calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("three-year backfill -> several messages relay, each within budget; rerun after completion makes zero outbound", async () => {
    const { account } = await manualAccount(YEARS_3);

    const perMessage = await drain({ kind: "daily-prices", userId: USER });

    // 3 coins x 3 windows + EUR 3 windows x 2 (two legs) = 15 calls > one message's 8 -> at least two messages.
    expect(perMessage.length).toBeGreaterThanOrEqual(2);
    for (const n of perMessage) {
      expect(n).toBeLessThanOrEqual(DAILY_PRICES_UPSTREAM_CALLS);
      expect(n).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    }
    expect(perMessage[0]).toBeLessThanOrEqual(DAILY_PRICES_CALLS_PER_MESSAGE);

    // The table has prices (coins) / rates (EUR = BTC USD / BTC EUR = 100 / 80) for every day from the first activity to yesterday.
    const holdings = await db(USER).manual.listHoldings(account.id, "coingecko");
    const todayB = Math.floor(Date.now() / MS_PER_DAY);
    const past = Array.from({ length: YEARS_3 }, (_, i) => todayB - YEARS_3 + i);
    for (const h of holdings.filter((x) => x.ref)) {
      expect((await oracleDbFor(USER).tokenPrices.getDaily(h.id, past)).size).toBe(YEARS_3);
    }
    const eur = await oracleDbFor(USER).tokenPrices.getDailyByRef(
      tokenRef.issued(FIAT_NAMER, "EUR"),
      past,
    );
    expect(eur.size).toBe(YEARS_3);
    expect(eur.get(todayB - 1)).toBeCloseTo(1.25);

    // Rerun: one cache read, no calls at all.
    const again = rangeUpstream();
    const { sent } = await consume({ kind: "daily-prices", userId: USER });
    expect(rangeCalls(again.calls)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("upstream down -> this message acks and enqueues nothing further (no spinning in place), retry at the next hour", async () => {
    await manualAccount(10);
    rangeUpstream({ fail: true });
    const { state, sent } = await consume({ kind: "daily-prices", userId: USER });
    expect(state).toEqual({ acked: true, retried: false });
    expect(sent).toEqual([]);
  });

  // Other cases' upstream succeeds at once, so the "per call x attempts" half of the derivation is never reached. This one measures with an
  // always-down upstream how many attempts the adapter makes (N, how many times one URL is hit), then fails each URL's first (N - 1)
  // attempts: one message spends all `DAILY_PRICES_CALLS_PER_MESSAGE` windows, each tried N times, and must still be <= 50.
  it("worst case (every window uses up its retries) -> one message still <= 50 calls", async () => {
    // Four coins only this case uses (the daily price table is global and a full window in it means no outbound, so common coins would measure others' fills).
    // 4 coins x 3 windows = 12 windows > one message's 8 -> the budget is certainly spent.
    await manualAccount(YEARS_3, { coins: ["wa1x", "wb2x", "wc3x", "wd4x"], cash: false });

    const down = rangeUpstream({ fail: true });
    await consume({ kind: "daily-prices", userId: USER });
    const [firstUrl] = down.calls;
    const attempts = down.calls.filter((u) => u === firstUrl).length;
    expect(attempts).toBeGreaterThan(1); // really retrying

    const flaky = rangeUpstream({ failFirst: attempts - 1 });
    const { state, sent } = await consume({ kind: "daily-prices", userId: USER });
    expect(state).toEqual({ acked: true, retried: false });
    expect(sent.length).toBeGreaterThan(0); // three years don't fit in one message -> the budget was really spent
    expect(rangeCalls(flaky.calls)).toBe(DAILY_PRICES_CALLS_PER_MESSAGE * attempts);
    expect(flaky.calls.length).toBeLessThanOrEqual(DAILY_PRICES_UPSTREAM_CALLS);
    expect(flaky.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  }, 60_000);

  it("the three chart-reading endpoints make no outbound call for manual accounts (filled or not)", async () => {
    const { account } = await manualAccount(YEARS_3);
    const reads = async () => {
      const outbound = blockOutbound();
      await call(USER, handleGetPortfolioHistory({ range: "all" }));
      await call(USER, handleGetAccountHistory({ accountId: account.id, range: "all" }));
      const now = Date.now();
      await call(USER, handleGetSnapshots({ at: now, after: now - 2 * MS_PER_DAY }));
      return outbound.calls;
    };

    expect(await reads()).toEqual([]); // not filled yet: missing days go down the degrade chain, no fetch
    await drain({ kind: "daily-prices", userId: USER });
    expect(await reads()).toEqual([]); // after filling: reads the table
  });

  it("after filling the curve uses daily prices; no price today -> carries yesterday's forward, doesn't fall back to the ledger price", async () => {
    const { account } = await manualAccount(5);
    await drain({ kind: "daily-prices", userId: USER });
    blockOutbound();
    const series = await call(USER, loadManualAccountSeries(account.id));
    const last = series.at(-1);
    // 3 coins x 1 x 100 + EUR 100 x 1.25 -- not the ledger's 1 / 1.1.
    expect(last?.totalUsd).toBeCloseTo(3 * 100 + 100 * 1.25);
  });

  it("after adding an activity -> enqueues one targeted `daily-prices` carrying this account's coin ids", async () => {
    const { account, queue } = await manualAccount(3);
    const daily = queue.sent.filter((m) => m.job.kind === "daily-prices");
    expect(daily).toHaveLength(1);
    const [msg] = daily;
    if (msg?.job.kind !== "daily-prices") throw new Error("no daily-prices job");
    const activities = await db(USER).manual.listActivityByAccount(account.id);
    const ids = [...new Set(activities.map((a) => a.tokenId))].sort();
    expect([...(msg.job.tokenIds ?? [])].sort()).toEqual(ids);
    expect(ids).toHaveLength(4);
    expect(msg.job.userId).toBe(USER);
    expect(msg.delaySeconds).toBeUndefined();
  });

  it("after editing an activity / creating a manual account also enqueues; an oversell rejection doesn't", async () => {
    const { account } = await manualAccount(3);
    const detail = await db(USER).manual.listActivityByAccount(account.id);
    const first = detail[0];
    if (!first) throw new Error("no activity");

    const edited = captureQueue();
    await call(
      USER,
      edited.provide(
        handleUpdateManualActivityAndRefill({
          activityId: first.id,
          patch: { occurredAt: first.occurredAt - 10 * MS_PER_DAY },
        }),
      ),
    );
    expect(edited.sent.map((m) => m.job.kind)).toEqual(["daily-prices"]);

    const rejected = captureQueue();
    const out = await call(
      USER,
      rejected.provide(
        handleCreateManualActivitiesAndRefill({
          accountId: account.id,
          drafts: [
            {
              token: { symbol: "BIT", unitPrice: 1, ticket: ticketOf("bitcoin") },
              kind: "reduce",
              amount: 999,
              occurredAt: Date.now(),
            },
          ],
        }),
      ),
    );
    expect(out.ok).toBe(false);
    expect(rejected.sent).toEqual([]);

    const created = captureQueue();
    const { registry } = await fakeRegistry();
    await callWithRegistry(
      USER,
      registry,
      created.provide(
        handleCreateAccountAndRefill({
          connectorId: "manual",
          label: "Manual 2",
          values: {
            tokens: JSON.stringify([
              { symbol: "BTC", unitPrice: 100, amount: 2, ticket: ticketOf("bitcoin") },
            ]),
          },
        }),
      ),
    );
    expect(created.sent.map((m) => m.job.kind)).toEqual(["daily-prices"]);
  });
});
