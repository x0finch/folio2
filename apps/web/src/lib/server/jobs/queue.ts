import { env } from "cloudflare:workers";
import { Context, Effect, Option } from "effect";
import { QUEUE_SEND_BATCH_MAX } from "./constants";
import type { Job } from "./message";

// **往队列里投活的那一处**(FOL-86)。

/** 一条要投的消息:活本身 + 可选的延迟(秒,见 `AFTER_SYNC_DELAY_SECONDS`)。 */
export interface Enqueued {
  readonly job: Job;
  readonly delaySeconds?: number;
}

/**
 * 投递端口。**可选服务**(CODING.md「能替换的东西一律是服务」):生产不 provide,走下面那个
 * 读 `env.JOBS` 的默认;测试 provide 一个把消息收进数组的假实现 —— workers-pool 的测试 Worker
 * 没有队列绑定,也不该有(那样消息会投进一个没人消费的地方,断言不到)。
 */
export class JobQueue extends Context.Tag("web/JobQueue")<
  JobQueue,
  { readonly send: (batch: readonly Enqueued[]) => Effect.Effect<void> }
>() {}

// 投递失败走 defect:cron 那一趟就该以异常收尾、就该可见(没投出去 = 这一小时没同步)。
const bindingQueue: JobQueue["Type"] = {
  send: (batch) =>
    Effect.promise(async () => {
      for (let i = 0; i < batch.length; i += QUEUE_SEND_BATCH_MAX) {
        await env.JOBS.sendBatch(
          batch.slice(i, i + QUEUE_SEND_BATCH_MAX).map((m) => ({
            body: m.job,
            contentType: "json" as const,
            delaySeconds: m.delaySeconds,
          })),
        );
      }
    }),
};

/** 投一批。空批不碰绑定。 */
export const enqueue = (batch: readonly Enqueued[]): Effect.Effect<void> =>
  batch.length === 0
    ? Effect.void
    : Effect.flatMap(Effect.serviceOption(JobQueue), (queue) =>
        Option.getOrElse(queue, () => bindingQueue).send(batch),
      );
