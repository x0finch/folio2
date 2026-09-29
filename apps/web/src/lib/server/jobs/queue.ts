import { env } from "cloudflare:workers";
import { Context, Effect, Option } from "effect";
import { JOB_RUNNER_NAME } from "./constants";
import type { Job } from "./message";

// **投活的那一处**(FOL-86)。FOL-100 起活投给运行器那个 Durable Object(`durable.ts`,ADR 0058),
// 不再是 Cloudflare 队列;名字仍叫「队列」—— 对投活的一方它就是一条队列:排进去、按时被跑、失败重试。

/** 一条要投的消息:活本身 + 可选的延迟(秒,见 `AFTER_SYNC_DELAY_SECONDS`)。 */
export interface Enqueued {
  readonly job: Job;
  readonly delaySeconds?: number;
}

/**
 * 投递端口。**可选服务**(CODING.md「能替换的东西一律是服务」):生产不 provide,走下面那个
 * 调 `env.JOB_RUNNER` 的默认;测试 provide 一个把消息收进数组的假实现 —— workers-pool 的测试 Worker
 * 没有运行器绑定,也不该有(那样活会投进一个没人断言的地方)。
 */
export class JobQueue extends Context.Tag("web/JobQueue")<
  JobQueue,
  { readonly send: (batch: readonly Enqueued[]) => Effect.Effect<void> }
>() {}

// 投递失败走 defect:cron 那一趟就该以异常收尾、就该可见(没投出去 = 这一小时没同步)。
// 一批一次 RPC:DO 那头一次写进去、定一次 alarm(RPC 的载荷上限是 MiB 级,一小时的活远在其下)。
const runnerQueue: JobQueue["Type"] = {
  send: (batch) =>
    Effect.promise(() => {
      const runner = env.JOB_RUNNER.get(env.JOB_RUNNER.idFromName(JOB_RUNNER_NAME));
      return runner.enqueue(batch.map((m) => ({ job: m.job, delaySeconds: m.delaySeconds })));
    }),
};

/** 投一批。空批不碰绑定。 */
export const enqueue = (batch: readonly Enqueued[]): Effect.Effect<void> =>
  batch.length === 0
    ? Effect.void
    : Effect.flatMap(Effect.serviceOption(JobQueue), (queue) =>
        Option.getOrElse(queue, () => runnerQueue).send(batch),
      );

/**
 * 戳运行器一下(cron 每次都调):按表里的事实补 alarm、卡住了就记 warn(见 `JobRunner.poke`)。
 * 与投活同一条端口规则:测试不 provide 运行器,这里走默认绑定 —— 所以只在 `scheduled()` 那一处调。
 */
export const pokeRunner: Effect.Effect<{ pending: number; dead: number }> = Effect.promise(() =>
  env.JOB_RUNNER.get(env.JOB_RUNNER.idFromName(JOB_RUNNER_NAME)).poke(),
);
