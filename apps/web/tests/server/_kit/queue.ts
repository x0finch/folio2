import { Effect } from "effect";
import { consumeMessage } from "@/lib/server/jobs/consume";
import type { SyncAccountJob } from "@/lib/server/jobs/message";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";

// **把投进队列的消息收进一个数组,再一条条交给真 consumer。**
//
// workers-pool 的测试 Worker 没有队列绑定(也不该有:消息会投进一个没人消费的地方,断言不到),
// 所以投递那一侧换成 `JobQueue` 的假实现(生产代码为此留的可选服务),消费那一侧走生产的
// `consumeMessage` —— 「投的形状」与「认的形状」是同一个,中间不手拼。

export const captureQueue = () => {
  const sent: Enqueued[] = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, JobQueue, {
      send: (batch) => Effect.sync(() => void sent.push(...batch)),
    });
  const syncJobs = (): SyncAccountJob[] =>
    sent.flatMap((m) => (m.job.kind === "sync-account" ? [m.job] : []));
  return { sent, provide, syncJobs };
};

/** 一条消息交给 consumer,回它的下场(ack / retry)。第几次投递可指定。 */
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
