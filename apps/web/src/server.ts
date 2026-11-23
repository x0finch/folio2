import { GlobalDatabase } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { Cause, Effect, Exit } from "effect";
import { withDefaultNoStore } from "./lib/server/entry/cache-headers";
import { configureLogging } from "./lib/server/entry/log";
import { pokeRunner } from "./lib/server/jobs/queue";
import { fanOutDaily } from "./lib/server/jobs/schedule";
import { runAtEdge, withGlobalDb } from "./lib/server/runtime";
import { fanOutAllUsers } from "./lib/server/sync/round";

// Custom worker entry: wraps TanStack's fetch and adds scheduled() (cron fires only scheduled,
// never fetch). The JobRunner Durable Object must be a named export of the main module.
const cronLog = getLogger(["folio", "cron"]);
const webLog = getLogger(["folio", "web"]);

// Must match the first entry of triggers.crons in wrangler.jsonc: Workers can only branch on the
// controller.cron string.
const DAILY_CRON = "0 23 * * *";

// Lists users, so there is no userId to scope by: goes through GlobalDatabase.
const listUserIds = withGlobalDb(Effect.flatMap(GlobalDatabase, (db) => db.accounts.listUserIds()));

// Daily per-user jobs; enqueue only, no pruning or network here. Failures propagate to scheduled().
const enqueueDailyJobs = (cron: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const userIds = yield* listUserIds;
    const result = yield* fanOutDaily(userIds);
    cronLog.info("daily jobs enqueued", { cron, users: userIds.length, ...result });
  });

// Enqueue-only sweep: a cron invocation has 10ms CPU / 50 subrequests on the free plan, far too
// little to sync every account inline. Per-user failures are contained inside fanOutAllUsers.
const sweepAllUsers = (cron: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const userIds = yield* listUserIds;
    cronLog.info("cron sweep start", { cron, users: userIds.length });
    const result = yield* fanOutAllUsers(userIds);
    cronLog.info("cron sweep enqueued", { cron, ...result });
  });

const serverEntry = createServerEntry({
  fetch: async (request) => {
    await configureLogging();
    try {
      // The CF edge cache key ignores Cookie, so one missed header would serve one user's page to
      // another. Default no-store lives on this single exit so new routes are safe by default.
      return withDefaultNoStore(await handler.fetch(request));
    } catch (err) {
      // Non-server-fn paths (SSR/loaders) bypass requireAuth logging. Pathname only: no query.
      webLog.error("fetch handler threw", {
        path: new URL(request.url).pathname,
        error: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string })?.code,
      });
      throw err;
    }
  },
});

export default {
  ...serverEntry,

  // One scheduled() for both crons, branching on controller.cron. Always poke the runner as a
  // fallback in case the alarm chain broke; a poke failure is logged without masking the job error.
  async scheduled(controller: ScheduledController, _env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await configureLogging();
        try {
          await runAtEdge(
            (controller.cron === DAILY_CRON
              ? enqueueDailyJobs(controller.cron)
              : sweepAllUsers(controller.cron)
            ).pipe(
              Effect.ensuring(
                Effect.exit(pokeRunner).pipe(
                  Effect.tap((exit) =>
                    Exit.isFailure(exit)
                      ? Effect.sync(() =>
                          cronLog.error("runner poke failed", {
                            cron: controller.cron,
                            error: Cause.pretty(exit.cause),
                          }),
                        )
                      : Effect.void,
                  ),
                ),
              ),
            ),
          );
        } catch (err) {
          // A throw inside waitUntil becomes a silent unhandled rejection: log it, then rethrow.
          cronLog.error("cron threw", {
            cron: controller.cron,
            error: err instanceof Error ? err.message : String(err),
            code: (err as { code?: string })?.code,
          });
          throw err;
        }
      })(),
    );
  },
};

export { JobRunner } from "./lib/server/jobs/durable";
