import { Database } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { Clock, Effect } from "effect";
import type { PruneNotesJob } from "@/lib/server/jobs/message";
import { forUserDb } from "@/lib/server/runtime";

// Display-note retention: notes rarely change but each sync rewrites them (a note-bearing snapshot row is 25x larger).
// The UI reads only each account's latest note; history notes are read only by export, so old ones are pruned (one
// UPDATE, zero migration, clears existing data) rather than deduplicated. 7 days keeps recent export context.
// Why notes only, and why the latest snapshot per account is never pruned: see `SnapshotStore.pruneNotes`.
const NOTE_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * Consumer of `prune-notes`: prunes one user's notes outside retention; the daily cron enqueues one per user.
 * Idempotent (both UPDATEs gate on `note IS NOT NULL`); the window is computed from `Clock` when it runs, not when
 * enqueued. Failures (defects only) go to queue redelivery. Logs carry counts only.
 */
export const runPruneNotesJob = (job: PruneNotesJob): Effect.Effect<void, Error> =>
  forUserDb(
    job.userId,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const pruned = yield* (yield* Database).snapshots.pruneNotes(
        now - NOTE_RETENTION_DAYS * DAY_MS,
      );
      getLogger(["folio", "jobs"]).info("prune notes done", pruned);
    }),
  );
