import { isFinalAttempt, JOB_LEASE_MS, jobRetryDelayMs } from "./constants";
import type { JobMessage } from "./consume";
import type { JobStore } from "./store";

// One alarm runs one job: the free plan's 50-subrequest cap per invocation is about one
// `sync-account`. Rows are wrapped as `JobMessage`: ack() deletes, retry() backs off or buries.
// A job claimed with its final attempt already spent (DO died mid-run) is abandoned and buried,
// so a job that keeps crashing the DO can't loop forever. Unit-tested with `node:sqlite`.

export interface JobHandlers {
  readonly consume: (message: JobMessage) => Promise<void>;
  /** Give-up only; the runner buries the job afterwards. */
  readonly abandon: (message: Omit<JobMessage, "ack" | "retry">, reason: string) => Promise<void>;
}

type Outcome = "done" | "retry" | "buried";

/** `abandonError`: the give-up step itself threw; the job is buried anyway. */
export interface StepResult {
  readonly ran: {
    readonly id: number;
    readonly attempts: number;
    readonly outcome: Outcome;
    readonly abandonError?: string;
  } | null;
}

// Undecodable bodies pass through; the consumer's `decodeJob` rejects and acks them.
const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

export const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export async function runOneDueJob(store: JobStore, handlers: JobHandlers): Promise<StepResult> {
  const job = store.claimNext(Date.now(), JOB_LEASE_MS);
  if (!job) return { ran: null };
  const step = (outcome: Outcome, abandonError?: string): StepResult => ({
    ran: { id: job.id, attempts: job.attempts, outcome, abandonError },
  });

  // Backoff counts from settle time: a job that failed after 80s would otherwise retry immediately.
  const fail = (error: string): Outcome => {
    const now = Date.now();
    if (isFinalAttempt(job.attempts)) {
      store.bury(job.id, now, error);
      return "buried";
    }
    store.retryAt(job.id, now + jobRetryDelayMs(job.attempts), error);
    return "retry";
  };

  const base = { id: String(job.id), body: parse(job.body), attempts: job.attempts };

  // The previous (final) attempt never finished: give up and bury, even if give-up throws.
  if (isFinalAttempt(job.attempts - 1)) {
    const reason = `attempt ${job.attempts - 1} never finished (runner died mid-job)`;
    let abandonError: string | undefined;
    try {
      await handlers.abandon(base, reason);
    } catch (err) {
      abandonError = errorText(err);
    }
    store.bury(job.id, Date.now(), reason);
    return step("buried", abandonError);
  }

  // Neither ack nor retry, or a throw → failure, so a job never silently disappears.
  // Held in an object because TS narrowing can't see assignments inside callbacks.
  const settled: { outcome: Outcome | null } = { outcome: null };
  try {
    await handlers.consume({
      ...base,
      ack: () => {
        store.done(job.id);
        settled.outcome = "done";
      },
      retry: () => {
        settled.outcome = fail("job failed");
      },
    });
  } catch (err) {
    settled.outcome ??= fail(errorText(err));
  }
  return step(settled.outcome ?? fail("consumer settled neither ack nor retry"));
}

/**
 * Alarm time to set, or `null` to leave it. A null `current` means no alarm or we're inside one
 * (`getAlarm()` is null then), both of which need arming; force re-arm by passing null.
 */
export const alarmToSet = ({
  due,
  current,
  now,
}: {
  due: number | null;
  current: number | null;
  now: number;
}): number | null => {
  if (due === null) return null;
  const at = Math.max(due, now);
  return current !== null && current <= at ? null : at;
};

/**
 * Stalled if a job is due and our own recorded alarm is `stallMs` overdue. Not `getAlarm()`: it is
 * null while an alarm runs and may claim one exists on a broken chain.
 */
export const isStalled = ({
  due,
  armedAt,
  now,
  stallMs,
}: {
  due: number | null;
  armedAt: number | null;
  now: number;
  stallMs: number;
}): boolean => due !== null && due <= now && (armedAt === null || armedAt <= now - stallMs);
