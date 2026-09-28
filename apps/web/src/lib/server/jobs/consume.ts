import { getLogger } from "@logtape/logtape";
import { Cause, Effect, Either, Exit } from "effect";
import { warmTokensFor } from "@/lib/server/sync/deps";
import { giveUpQueuedAccount, syncQueuedAccount } from "@/lib/server/sync/round";
import { JOB_MAX_RETRIES } from "./constants";
import { decodeJob, type Job } from "./message";

// **队列 consumer 的分派**(FOL-86)。`src/server.ts` 的 `queue()` 每条消息调一次 `consumeMessage`,
// 在 isolate 运行时上跑(`runAtEdge`)—— 与 server fn / cron 同一张服务图,不另起一张。

/** 一条活真正要干的事。**穷尽 switch**:加了 kind 忘了接,这里编译不过。 */
const runJob = (job: Job): Effect.Effect<void, Error> => {
  switch (job.kind) {
    case "sync-account":
      return syncQueuedAccount(job);
    case "warm-user":
      return warmTokensFor(job.userId);
  }
};

/**
 * 最后一次投递也失败了,ack 之前还要做什么。**只有会让别处挂着的那种活才需要**:`sync-account` 不收尾,
 * 轮里那个账户永远 pending;预热失败了就是这一小时没暖上,没有谁在等它。
 */
const giveUp = (job: Job, reason: string): Effect.Effect<void, Error> => {
  switch (job.kind) {
    case "sync-account":
      return giveUpQueuedAccount(job, reason);
    case "warm-user":
      return Effect.void;
  }
};

// 收尾那句会落进轮的明细、显示在面板上 —— 要一句话,不要一棵 Cause 树。
const reasonOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/**
 * Cloudflare `Message` 里 consumer 用得到的那几样 —— 收窄成接口,单测递一个假的就够,不必造
 * 整个 `MessageBatch`。
 */
export interface QueueMessage {
  readonly id: string;
  readonly body: unknown;
  /** 第几次投递,从 1 起。 */
  readonly attempts: number;
  ack(): void;
  retry(): void;
}

/**
 * 一条消息:解码 → 跑 → **ack 或 retry,由这里一处决定**。永不失败(返回的 effect 错误面是 `never`),
 * 所以批里一条的下场不会波及别的消息、也不会变成 queue handler 的异常(那会让整批重投)。
 *
 *   · 解不开 → ack + warn。重投也还是解不开,留着只会烧掉重试次数、再掉进死信。
 *   · 跑成功 → ack。
 *   · 失败,还有重投机会 → `retry()`(延迟由 wrangler.jsonc 的 `retry_delay` 给)。
 *   · 失败,这是最后一次(`attempts > JOB_MAX_RETRIES`)→ `giveUp` 收尾后 ack;连收尾都失败 →
 *     `retry()`,消息进死信队列,留给人看。
 *
 * 日志只带 kind / 消息 id / 次数 / accountId 这一级(P6.7),错误是 `Cause.pretty`。
 *
 * `run` 可注入,只为单测能让一条活失败、走到重试 / 收尾那几支;生产用默认的 `runJob`。
 */
export const consumeMessage = (
  message: QueueMessage,
  run: (job: Job) => Effect.Effect<void, Error> = runJob,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const log = getLogger(["folio", "jobs"]);
    const decoded = decodeJob(message.body);
    if (Either.isLeft(decoded)) {
      log.warn("invalid job dropped", { messageId: message.id, error: decoded.left });
      message.ack();
      return;
    }
    const job = decoded.right;
    const exit = yield* Effect.exit(run(job));
    if (Exit.isSuccess(exit)) {
      message.ack();
      return;
    }
    const error = Cause.pretty(exit.cause);
    const meta = { kind: job.kind, messageId: message.id, attempts: message.attempts };
    if (message.attempts <= JOB_MAX_RETRIES) {
      log.warn("job failed, will retry", { ...meta, error });
      message.retry();
      return;
    }
    log.error("job failed on final attempt, giving up", { ...meta, error });
    const settled = yield* Effect.exit(
      giveUp(job, `failed ${message.attempts} times: ${reasonOf(exit.cause)}`),
    );
    if (Exit.isSuccess(settled)) {
      message.ack();
    } else {
      log.error("job give-up failed, sending to dead-letter queue", {
        ...meta,
        error: Cause.pretty(settled.cause),
      });
      message.retry();
    }
  });
