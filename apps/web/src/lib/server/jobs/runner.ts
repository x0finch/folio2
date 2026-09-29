import { JOB_LEASE_MS, JOB_MAX_RETRIES, jobRetryDelayMs } from "./constants";
import type { QueueMessage } from "./consume";
import type { JobStore } from "./store";

// **一次 alarm 干的事**(FOL-100,ADR 0058):领一件到点的活 → 交给 consumer → 按它的 ack / retry 记下场。
//
// **一次只跑一件。** 免费计划每次调用只有 50 个外部 subrequest,一条 `sync-account` 最坏就要用到那个量级
// (FOL-86 起每件活都按「一次调用的预算」切过),所以 alarm 不在一次调用里连跑几件 —— 跑完一件,
// 下一件是下一次 alarm。CPU 那一侧(DO 每次调用的上限)见 ADR 0058 的前提。
//
// consumer 还是 FOL-86 那一个(`consumeMessage`):它只认「一条消息 + ack / retry」,不关心消息是从
// 队列来的还是从这张表来的。这里把表里的一行包成那个形状:
//   · `ack()`   → 删掉这一行。
//   · `retry()` → 次数没用完:按指数退避排下一次;用完了(consumer 已经先收过尾):埋掉。
// 纯逻辑、不碰 `cloudflare:workers`,单测直接递一个 `node:sqlite` 的 store(见 tests/job-runner.test.ts)。

/** consumer:收一条消息,自己决定 ack 还是 retry。生产是 `runAtEdge(consumeMessage(message))`。 */
export type Consume = (message: QueueMessage) => Promise<void>;

/** 这一次 alarm 的下场:跑了哪件活(没有到点的 → `null`)。 */
export interface StepResult {
  readonly ran: {
    readonly id: number;
    readonly attempts: number;
    readonly outcome: Outcome;
  } | null;
}

type Outcome = "done" | "retry" | "buried";

// 解不开的消息体原样交给 consumer —— 它的 `decodeJob` 会拒掉、ack、记一条 warn(与队列时代同一个口径)。
const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

/**
 * `clock` 读两次:领活时(谁到点了)与记下场时(退避从**跑完那一刻**起算 —— 一件跑了 80s 才失败的活,
 * 从领的那一刻算 30s 退避,记下场时就已经到点了,等于没退避)。
 */
export async function runOneDueJob(
  store: JobStore,
  consume: Consume,
  clock: () => number = Date.now,
): Promise<StepResult> {
  const job = store.claimNext(clock(), JOB_LEASE_MS);
  if (!job) return { ran: null };

  // consumer 没表态(既没 ack 也没 retry)或自己抛了 → 按 retry 算:活不能因为一次意外就悄悄没了。
  // 装在对象里:下场是在回调里定的,TS 的控制流收窄看不见闭包里的赋值。
  const settled: { outcome: Outcome | null } = { outcome: null };
  const retry = (error: string) => {
    const now = clock();
    if (job.attempts > JOB_MAX_RETRIES) {
      store.bury(job.id, now, error);
      settled.outcome = "buried";
    } else {
      store.retryAt(job.id, now + jobRetryDelayMs(job.attempts), error);
      settled.outcome = "retry";
    }
  };
  try {
    await consume({
      id: String(job.id),
      body: parse(job.body),
      attempts: job.attempts,
      ack: () => {
        store.done(job.id);
        settled.outcome = "done";
      },
      retry: () => retry("job failed"),
    });
  } catch (err) {
    if (settled.outcome === null) retry(err instanceof Error ? err.message : String(err));
  }
  if (settled.outcome === null) retry("consumer settled neither ack nor retry");
  return { ran: { id: job.id, attempts: job.attempts, outcome: settled.outcome ?? "retry" } };
}
