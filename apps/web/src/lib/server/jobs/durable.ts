import { DurableObject } from "cloudflare:workers";
import { getLogger } from "@logtape/logtape";
import { configureLogging } from "@/lib/server/entry/log";
import { runAtEdge } from "@/lib/server/runtime";
import { DEAD_JOB_RETENTION_MS, RUNNER_STALL_MS } from "./constants";
import { abandonMessage, consumeMessage } from "./consume";
import type { Enqueued } from "./queue";
import { alarmToSet, errorText, isStalled, runOneDueJob } from "./runner";
import { createJobStore, type JobStore } from "./store";

// Job runner: a SQLite-backed Durable Object. Cron and server fns only enqueue or poke; the DO
// stores jobs and runs one per alarm. Results land in D1 idempotently, so a double run is harmless.
// Why a DO: a free-plan queue consumer gets 10ms CPU per call, and a `sync-account` takes ~50ms.
// One instance for all users; sharding per user would only change `idFromName`.
const log = getLogger(["folio", "jobs", "runner"]);

export class JobRunner extends DurableObject<Cloudflare.Env> {
  private readonly store: JobStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.store = createJobStore(ctx.storage.sql);
  }

  async enqueue(jobs: readonly Enqueued[]): Promise<void> {
    const now = Date.now();
    this.store.add(
      jobs.map((j) => ({
        body: JSON.stringify(j.job),
        runAt: now + (j.delaySeconds ?? 0) * 1000,
      })),
    );
    await this.arm();
  }

  /**
   * Called on every cron. `getAlarm()` alone can't detect a broken alarm chain (it is null while
   * running), so compare against our own recorded alarm time and force re-arm when overdue.
   * Also prunes dead jobs here, hourly is enough.
   */
  async poke(): Promise<void> {
    await configureLogging();
    const now = Date.now();
    this.store.pruneDead(now - DEAD_JOB_RETENTION_MS);
    const due = this.store.nextRunAt();
    const stalled = isStalled({
      due,
      armedAt: this.store.alarmAt(),
      now,
      stallMs: RUNNER_STALL_MS,
    });
    if (stalled) {
      log.warn("job runner looks stalled, re-arming", {
        ...this.store.counts(),
        overdueMs: now - (due ?? now),
      });
    }
    await this.arm({ force: stalled });
  }

  /** Runs one due job, then re-arms. Always returns normally: retries are scheduled by us. */
  async alarm(): Promise<void> {
    try {
      await configureLogging();
      const { ran } = await runOneDueJob(this.store, {
        consume: (message) => runAtEdge(consumeMessage(message)),
        abandon: (message, reason) => runAtEdge(abandonMessage(message, reason)),
      });
      // The consumer already logged the burial; only a failed give-up step is left to report.
      if (ran?.abandonError) log.error("job give-up could not run", { ...ran });
    } catch (err) {
      // Only store SQL or logging setup can throw here; consumer errors are caught upstream.
      log.error("job runner step threw", { error: errorText(err) });
    }
    try {
      await this.arm();
    } catch (err) {
      // The next cron poke detects the missed alarm and re-arms.
      log.error("job runner could not re-arm", { error: errorText(err) });
    }
  }

  /** Keeps the alarm no later than the earliest job; records the time only when it changes. */
  private async arm({ force = false }: { force?: boolean } = {}): Promise<void> {
    const due = this.store.nextRunAt();
    if (due === null) return;
    const current = force ? null : await this.ctx.storage.getAlarm();
    const at = alarmToSet({ due, current, now: Date.now() });
    if (at === null) return;
    await this.ctx.storage.setAlarm(at);
    this.store.noteAlarm(at);
  }
}
