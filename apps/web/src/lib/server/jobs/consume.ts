import { getLogger } from "@logtape/logtape";
import { Cause, Effect, Either, Exit } from "effect";
import { runPruneNotesJob } from "@/lib/server/entry/note-retention";
import { runDailyPricesJob } from "@/lib/server/prices/daily";
import { runPricesJob } from "@/lib/server/prices/job";
import { runReferenceJob } from "@/lib/server/sync/reference";
import { giveUpQueuedAccount, syncQueuedAccount } from "@/lib/server/sync/round";
import { isFinalAttempt } from "./constants";
import { decodeJob, type Job } from "./message";

// **后台活 consumer 的分派**(FOL-86)。运行器那个 DO 的 alarm(`durable.ts`,FOL-100)每件活调一次
// `consumeMessage`,经 `runAtEdge` 跑在 `dbRuntime` 上;要参考层 / connector 的活由`forUser`(整张图)/ `forUserDb`(只要 db)
// 在同一个 isolate 的服务图里补上 —— 不另起一张图(见 runtime.ts 顶部)。

/** 一条活真正要干的事。**穷尽 switch**:加了 kind 忘了接,这里编译不过。 */
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
 * 最后一次投递也失败了,被埋掉之前还要做什么。**只有会让别处挂着的那种活才需要**:`sync-account`
 * 不收尾,轮里那个账户要等心跳过期才被念成(整轮)「中断」;刷价 / 预热 / 剪 note 失败了就是这一轮
 * 没做上(下一次 cron 再投),没有谁在等它。
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

// 收尾那句会落进轮的明细、显示在面板上 —— 要一句话,不要一棵 Cause 树。
const reasonOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/**
 * 一条消息里 consumer 用得到的那几样。FOL-86 时它是 Cloudflare 队列 `Message` 的收窄;FOL-100 起由运行器
 * 把自己表里的一行包成这个形状(`runner.ts`)—— consumer 不关心消息从哪来。单测递一个假的就够。
 */
export interface JobMessage {
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
 *   · 解不开 → ack + warn。重跑也还是解不开,留着只会烧掉重试次数、再被埋掉。
 *   · 跑成功 → ack。
 *   · 失败,还有重跑机会 → `retry()`(运行器按指数退避排下一次,`jobRetryDelayMs`)。
 *   · 失败,这是最后一次(`isFinalAttempt`)→ `giveUp` 收尾(不管收尾成没成)再 `retry()`:
 *     次数已用完,运行器把这件活**埋掉**(留在 DO 存储里、标上死亡时间,给人看 —— 等价于以前的死信队列,
 *     FOL-86 验收:失败的活看得见)。收尾先做,所以轮不挂 pending;埋掉的不会再被领。真有人把它挖出来
 *     重跑,`sync-account` 那条也只会被「还 pending 吗」挡下(收尾已把账户记成 failed)。
 *
 * 日志只带 kind / 消息 id / 次数 / accountId 这一级(P6.7),错误是 `Cause.pretty`。
 *
 * `run` 可注入,只为单测能让一条活失败、走到重试 / 收尾那几支;生产用默认的 `runJob`。
 */
export const consumeMessage = (
  message: JobMessage,
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
    const meta = { kind: job.kind, messageId: message.id, attempts: message.attempts };
    if (Exit.isSuccess(exit)) {
      // 每条一行、带 kind:Workers Logs 里一次 queue 调用本身不带「这是哪件活」,按 kind 拆 CPU
      // (线上查询与 perf:cpu:jobs 都靠它认)就只能读这一行。
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

/** 收尾(`giveUp`),收尾自己失败了只记一条 error —— 活照样要被埋掉,收尾不挡它。永不失败。 */
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
 * **不跑,只收尾**:上一次本该是最后一次,却没跑完(DO 在跑的中途没了 —— 超 CPU、实例重启),运行器领到它时
 * 次数已经超了(`runner.ts`)。再跑一遍多半还是同样的下场,所以直接走 `giveUp`(`sync-account`:账户记
 * failed、够了就收官),然后由运行器埋掉。永不失败;解不开的消息体没有可收的尾,只记一条 warn。
 */
export const abandonMessage = (
  message: Omit<JobMessage, "ack" | "retry">,
  reason: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const log = getLogger(["folio", "jobs"]);
    const decoded = decodeJob(message.body);
    if (Either.isLeft(decoded)) {
      log.warn("invalid job abandoned", { messageId: message.id, error: decoded.left });
      return;
    }
    const meta = { kind: decoded.right.kind, messageId: message.id, attempts: message.attempts };
    log.error("job never finished its final attempt, burying it", meta);
    yield* settleGiveUp(decoded.right, reason, meta);
  });
