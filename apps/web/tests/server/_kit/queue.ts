import { Effect } from "effect";
import { consumeMessage } from "@/lib/server/jobs/consume";
import type { SyncAccountJob } from "@/lib/server/jobs/message";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";

// The test Worker has no queue binding, so enqueued messages are collected in an array (fake
// `JobQueue`) and handed to the real `consumeMessage`.

export const captureQueue = () => {
  const sent: Enqueued[] = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, JobQueue, {
      send: (batch) => Effect.sync(() => void sent.push(...batch)),
      poke: Effect.void,
    });
  const syncJobs = (): SyncAccountJob[] =>
    sent.flatMap((m) => (m.job.kind === "sync-account" ? [m.job] : []));
  return { sent, provide, syncJobs };
};

export const consumeJob = (body: unknown, attempts = 1) => {
  const state = { acked: false, retried: false };
  return Effect.runPromise(
    consumeMessage({
      id: `m-${Math.random()}`,
      body,
      attempts,
      ack: () => {
        state.acked = true;
      },
      retry: () => {
        state.retried = true;
      },
    }),
  ).then(() => state);
};
