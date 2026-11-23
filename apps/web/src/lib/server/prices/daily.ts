import { Database } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Cause, Effect } from "effect";
import {
  DAILY_PRICES_CALLS_PER_MESSAGE,
  DAILY_PRICES_IDS_PER_MESSAGE,
} from "@/lib/server/jobs/constants";
import type { DailyPricesJob } from "@/lib/server/jobs/message";
import { type Enqueued, enqueue } from "@/lib/server/jobs/queue";
import { manualAccountTokenIds, manualDailyPriceTargets } from "@/lib/server/manual/store";
import { enqueueForUser, forUser, type UserServices } from "@/lib/server/runtime";

// Where manual-account daily prices get backfilled: manual accounts write no snapshots, their curve is the
// ledger times daily prices, and reads only read the table. Fed by the hourly cron (one id-less message per user)
// and by a targeted message after a manual write. Budget per message is `DAILY_PRICES_CALLS_PER_MESSAGE` range
// requests, nearest days first; leftovers enqueue one follow-up, but not if nothing was spent, so the relay can't loop.
// Several messages may fill the same token concurrently: writes are upserts and the filled-range is unioned on finish.

const log = getLogger(["folio", "jobs", "daily-prices"]);

const chunked = (ids: readonly string[]): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += DAILY_PRICES_IDS_PER_MESSAGE) {
    out.push(ids.slice(i, i + DAILY_PRICES_IDS_PER_MESSAGE));
  }
  return out;
};

const jobsFor = (userId: string, tokenIds: readonly string[]): Enqueued[] =>
  chunked(tokenIds).map((ids) => ({ job: { kind: "daily-prices", userId, tokenIds: ids } }));

export const runDailyPricesJob = (job: DailyPricesJob): Effect.Effect<void, Error> =>
  forUser(
    job.userId,
    Effect.gen(function* () {
      const accounts = yield* (yield* Database).accounts.list();
      const all = yield* manualDailyPriceTargets(accounts);
      const only = job.tokenIds ? new Set(job.tokenIds) : undefined;
      const targets = only ? all.filter((t) => only.has(t.tokenId)) : all;
      if (targets.length === 0) return;

      const { tokens, fx } = yield* Oracle;
      let budget = DAILY_PRICES_CALLS_PER_MESSAGE;
      let failed = 0;
      const unfinished: string[] = [];
      for (const t of targets) {
        if (budget <= 0) {
          unfinished.push(t.tokenId);
          continue;
        }
        const report = t.fiatCode
          ? yield* fx.fillDaily(t.fiatCode, t.fromMs, budget)
          : yield* tokens.fillDaily(t.tokenId, t.fromMs, budget);
        budget -= report.calls;
        if (report.failed) failed++;
        else if (!report.done) unfinished.push(t.tokenId);
      }

      const spent = DAILY_PRICES_CALLS_PER_MESSAGE - budget;
      const meta = { targets: targets.length, calls: spent, failed, unfinished: unfinished.length };
      if (spent > 0 || failed > 0) log.info("daily prices filled", meta);
      // Nothing spent with work left means the budget can't cover one window; don't re-enqueue the same message forever.
      if (unfinished.length === 0 || spent === 0) return;
      yield* enqueue(jobsFor(job.userId, unfinished));
    }),
  );

/** Best effort: a failed enqueue is logged and doesn't fail the already-stored write (the next hourly cron backfills). */
export const refillDailyPrices = (accountId: string): Effect.Effect<void, never, UserServices> =>
  Effect.gen(function* () {
    const ids = yield* manualAccountTokenIds(accountId);
    yield* enqueueForUser((userId) => jobsFor(userId, ids));
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() =>
        log.warn("daily prices refill not queued", { accountId, error: Cause.pretty(cause) }),
      ),
    ),
  );
