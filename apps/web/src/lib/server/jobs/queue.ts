import { env } from "cloudflare:workers";
import { Context, Effect, Option } from "effect";
import { JOB_RUNNER_NAME } from "./constants";
import type { Job } from "./message";

// Jobs go to the runner Durable Object; to the caller it behaves like a queue.

/** `delaySeconds` see `AFTER_SYNC_DELAY_SECONDS`. */
export interface Enqueued {
  readonly job: Job;
  readonly delaySeconds?: number;
}

/**
 * Optional service: production falls back to `env.JOB_RUNNER`; tests provide a fake that collects
 * messages, since the test Worker has no runner binding.
 */
export class JobQueue extends Context.Service<
  JobQueue,
  {
    readonly send: (batch: readonly Enqueued[]) => Effect.Effect<void>;
    readonly poke: Effect.Effect<void>;
  }
>()("web/JobQueue") {}

const runner = () => env.JOB_RUNNER.get(env.JOB_RUNNER.idFromName(JOB_RUNNER_NAME));

// Send failures are defects: a cron that couldn't enqueue should fail loudly. One RPC per batch.
const runnerQueue: JobQueue["Service"] = {
  send: (batch) => Effect.promise(() => runner().enqueue(batch)),
  poke: Effect.promise(() => runner().poke()),
};

const port = Effect.map(
  Effect.serviceOption(JobQueue),
  Option.getOrElse(() => runnerQueue),
);

/** Empty batches don't touch the binding. */
export const enqueue = (batch: readonly Enqueued[]): Effect.Effect<void> =>
  batch.length === 0 ? Effect.void : Effect.flatMap(port, (queue) => queue.send(batch));

export const pokeRunner: Effect.Effect<void> = Effect.flatMap(port, (queue) => queue.poke);
