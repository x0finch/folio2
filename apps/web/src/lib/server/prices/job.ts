import { type BalanceRawRow, Database, type DbRequest, type NotFound } from "@folio/db";
import { Oracle, type RefreshStaleReport } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { refreshableTokenIds, userDisplayBalances } from "@/lib/core/token-model";
import { PRICES_IDS_PER_MESSAGE } from "@/lib/server/jobs/constants";
import type { PricesJob } from "@/lib/server/jobs/message";
import { type Enqueued, enqueue } from "@/lib/server/jobs/queue";
import { manualBalancesForWarm } from "@/lib/server/manual/store";
import { forUser } from "@/lib/server/runtime";

// Where holdings prices are fetched: the hourly cron enqueues a `prices` message per user and this consumer fetches in
// batches of 100 and writes the price table; revaluation and display only read the table.

const log = getLogger(["folio", "jobs", "prices"]);

/**
 * The tokens the user is looking at now: latest snapshot + manual synthetic balances, through the same dust gate
 * (`refreshableTokenIds`). The display's stale set must be a subset of this, or stale tokens never refresh.
 * Snapshot balances are raw tuples (`latestRaw`): only four columns needed.
 */
const heldTokenIdsOf = (
  snapshotRows: readonly BalanceRawRow[],
): Effect.Effect<string[], NotFound, Database | DbRequest> =>
  Effect.gen(function* () {
    const accounts = yield* (yield* Database).accounts.list();
    // Manual accounts write no snapshots: synthesize balances from their creds, or manual-only users' tokens never get priced.
    const manualBalances = yield* manualBalancesForWarm(accounts);
    return refreshableTokenIds(userDisplayBalances(snapshotRows, manualBalances));
  });

/** Refreshes stale or missing prices / meta in one id batch. Callers keep the batch within one message's budget (`PRICES_IDS_PER_MESSAGE`). A failure to warm is logged loudly. */
const refreshPricesOf = (
  ids: readonly string[],
): Effect.Effect<RefreshStaleReport, never, Oracle | DbRequest> =>
  Effect.tap(
    Effect.flatMap(Oracle, (o) => o.tokens.refreshStale(ids)),
    (report) =>
      Effect.sync(() => {
        const meta = { ids: ids.length, ...report };
        if (report.degraded) log.warn("held prices partially refreshed", meta);
        else log.debug("held prices refreshed", meta);
      }),
  );

/** Splits by budget; empty input gives one empty chunk (the planning message still "refreshes", with no network). */
const chunkTokenIds = (
  ids: readonly string[],
  size: number = PRICES_IDS_PER_MESSAGE,
): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out.length === 0 ? [[]] : out;
};

/**
 * Consumer of `prices`. The planning message (no `tokenIds`) refreshes the first chunk and enqueues the rest; a chunk
 * message refreshes only its own. Refresh before enqueue: refresh is idempotent, enqueue isn't, so a redelivery after a
 * failure doesn't re-enqueue the later chunks twice.
 */
export const runPricesJob = (job: PricesJob): Effect.Effect<void, Error> =>
  forUser(
    job.userId,
    Effect.gen(function* () {
      if (job.tokenIds) {
        yield* refreshPricesOf(job.tokenIds);
        return;
      }
      const { balances } = yield* (yield* Database).snapshots.latestRaw();
      const [head = [], ...rest] = chunkTokenIds(yield* heldTokenIdsOf(balances));
      yield* refreshPricesOf(head);
      if (rest.length === 0) return;
      log.info("held prices split across messages", { messages: rest.length + 1 });
      yield* enqueue(
        rest.map(
          (tokenIds): Enqueued => ({ job: { kind: "prices", userId: job.userId, tokenIds } }),
        ),
      );
    }),
  );
