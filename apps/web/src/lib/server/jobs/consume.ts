import { getLogger } from "@logtape/logtape";
import { Cause, Effect, Exit, Result } from "effect";
import { runPruneNotesJob } from "@/lib/server/entry/note-retention";
import { runDailyPricesJob } from "@/lib/server/prices/daily";
import { runPricesJob } from "@/lib/server/prices/job";
import { runReferenceJob } from "@/lib/server/sync/reference";
import { giveUpQueuedAccount, syncQueuedAccount } from "@/lib/server/sync/round";
import { isFinalAttempt } from "./constants";
import { decodeJob, type Job } from "./message";

/** Exhaustive switch: a new kind that isn't wired fails to compile. */
const runJob = (job: Job): Effect.Effect<void, Error> => {
  switch (job.kind) {
    case "sync-account":
      return syncQueuedAccount(job);
    case "prices":
      return runPricesJob(job);
    case "daily-prices":
      return runDailyPricesJob(job);
    case "fx":
    case "platforms":
    case "catalogue":
    case "defi-logos":
      return runReferenceJob(job);
    case "prune-notes":
      return runPruneNotesJob(job);
  }
};

/**
 * Cleanup before burying a job. Only `sync-account` needs it: otherwise its round sits pending
 * until the heartbeat expires. Other kinds simply retry on the next cron.
 */
const giveUp = (job: Job, reason: string): Effect.Effect<void, Error> => {
  switch (job.kind) {
    case "sync-account":
      return giveUpQueuedAccount(job, reason);
    case "prices":
    case "daily-prices":
    case "fx":
    case "platforms":
    case "catalogue":
    case "defi-logos":
    case "prune-notes":
      return Effect.void;
  }
};

// Shown on the round panel: one sentence, not a Cause tree.
const reasonOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/** What the consumer needs from a message; the runner wraps its own rows in this shape. */
export interface JobMessage {
  readonly id: string;
  readonly body: unknown;
  /** 1-based. */
  readonly attempts: number;
  ack(): void;
  retry(): void;
}

/**
 * Decode → run → ack or retry, decided only here. Never fails, so one job can't affect others.
 * Undecodable → ack + warn (retrying can't help). Final failure → `giveUp` first, so the round
 * isn't left pending, then `retry()`, which buries the job since attempts are exhausted.
 * `run` is injectable for tests.
 */
export const consumeMessage = (
  message: JobMessage,
  run: (job: Job) => Effect.Effect<void, Error> = runJob,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const log = getLogger(["folio", "jobs"]);
    const decoded = decodeJob(message.body);
    if (Result.isFailure(decoded)) {
      log.warn("invalid job dropped", { messageId: message.id, error: decoded.failure });
      message.ack();
      return;
    }
    const job = decoded.success;
    const exit = yield* Effect.exit(run(job));
    const meta = { kind: job.kind, messageId: message.id, attempts: message.attempts };
    if (Exit.isSuccess(exit)) {
      // One line per job with its kind: Workers Logs can't otherwise attribute CPU to a job kind.
      log.info("job done", meta);
      message.ack();
      return;
    }
    const error = Cause.pretty(exit.cause);
    if (!isFinalAttempt(message.attempts)) {
      log.warn("job failed, will retry", { ...meta, error });
      message.retry();
      return;
    }
    log.error("job failed on final attempt, burying it", { ...meta, error });
    yield* settleGiveUp(job, `failed ${message.attempts} times: ${reasonOf(exit.cause)}`, meta);
    message.retry();
  });

/** A failed give-up only logs: the job is buried regardless. Never fails. */
const settleGiveUp = (
  job: Job,
  reason: string,
  meta: Record<string, unknown>,
): Effect.Effect<void> =>
  Effect.flatMap(Effect.exit(giveUp(job, reason)), (settled) =>
    Effect.sync(() => {
      if (Exit.isFailure(settled)) {
        getLogger(["folio", "jobs"]).error("job give-up failed", {
          ...meta,
          error: Cause.pretty(settled.cause),
        });
      }
    }),
  );

/**
 * Give up without running: the final attempt never finished (DO evicted mid-run), and rerunning
 * would likely end the same way. Never fails.
 */
export const abandonMessage = (
  message: Omit<JobMessage, "ack" | "retry">,
  reason: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const log = getLogger(["folio", "jobs"]);
    const decoded = decodeJob(message.body);
    if (Result.isFailure(decoded)) {
      log.warn("invalid job abandoned", { messageId: message.id, error: decoded.failure });
      return;
    }
    const meta = { kind: decoded.success.kind, messageId: message.id, attempts: message.attempts };
    log.error("job never finished its final attempt, burying it", meta);
    yield* settleGiveUp(decoded.success, reason, meta);
  });
