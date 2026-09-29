import { isFinalAttempt, JOB_LEASE_MS, jobRetryDelayMs } from "./constants";
import type { JobMessage } from "./consume";
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
// **领到时次数已经超了**(上一次本该是最后一次,DO 却在跑的中途没了、没记上下场)→ 不再跑,交给
// `abandon` 收尾后埋掉:一件每次都把 DO 跑崩的活,不会每个租期重来一遍、永远埋不掉。
// 纯逻辑、不碰 `cloudflare:workers`,单测直接递一个 `node:sqlite` 的 store(见 tests/job-runner.test.ts)。

/** 生产是 `runAtEdge(consumeMessage(message))` / `runAtEdge(abandonMessage(message, reason))`。 */
export interface JobHandlers {
  /** 跑一件:自己决定 ack 还是 retry。 */
  readonly consume: (message: JobMessage) => Promise<void>;
  /** 不跑,只收尾(见上)。 */
  readonly abandon: (message: JobMessage, reason: string) => Promise<void>;
}

type Outcome = "done" | "retry" | "buried";

/** 这一次 alarm 的下场:跑了哪件活(没有到点的 → `null`)。 */
export interface StepResult {
  readonly ran: {
    readonly id: number;
    readonly attempts: number;
    readonly outcome: Outcome;
  } | null;
}

// 解不开的消息体原样交给 consumer —— 它的 `decodeJob` 会拒掉、ack、记一条 warn(与队列时代同一个口径)。
const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runOneDueJob(store: JobStore, handlers: JobHandlers): Promise<StepResult> {
  const job = store.claimNext(Date.now(), JOB_LEASE_MS);
  if (!job) return { ran: null };
  const step = (outcome: Outcome): StepResult => ({
    ran: { id: job.id, attempts: job.attempts, outcome },
  });

  // 失败后的下场。时刻取**记下场那一刻**:一件跑了 80s 才失败的活,从领的那一刻算 30s 退避,
  // 记下场时就已经到点了,等于没退避。
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

  // 上一次(最后一次)没跑完:收尾、埋掉,不再跑。收尾出错也照埋 —— 埋掉才是止损。
  if (isFinalAttempt(job.attempts - 1)) {
    const reason = `attempt ${job.attempts - 1} never finished (runner died mid-job)`;
    try {
      await handlers.abandon({ ...base, ack: () => {}, retry: () => {} }, reason);
    } catch {
      // `abandonMessage` 本身永不失败;真抛了也不挡埋。
    }
    store.bury(job.id, Date.now(), reason);
    return step("buried");
  }

  // consumer 没表态(既没 ack 也没 retry)或自己抛了 → 按失败算:活不能因为一次意外就悄悄没了。
  // 下场装在对象里:它是在回调里定的,TS 的控制流收窄看不见闭包里的赋值。
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
