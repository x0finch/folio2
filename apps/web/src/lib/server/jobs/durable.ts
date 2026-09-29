import { DurableObject } from "cloudflare:workers";
import { getLogger } from "@logtape/logtape";
import { configureLogging } from "@/lib/server/entry/log";
import { runAtEdge } from "@/lib/server/runtime";
import { DEAD_JOB_RETENTION_MS, RUNNER_STALL_MS } from "./constants";
import { consumeMessage } from "./consume";
import type { Enqueued } from "./queue";
import { runOneDueJob } from "./runner";
import { JobStore } from "./store";

// **后台任务运行器**(FOL-100,ADR 0058):一个 SQLite 存储的 Durable Object,取代 FOL-86 的 Cloudflare 队列。
//
// 三个角色:
//   · cron / server fn 是**闹钟**:只往这里投活(`enqueue`)、或戳一下(`poke`),不干活。
//   · 这个 DO 是**调度 + 干活的那个**:活排在它自己的 SQLite 里(`JobStore`),alarm 一次跑一件
//     (`runOneDueJob`),跑完按下一件的到点时间再定 alarm。
//   · D1 是**结果账本**:每件活写的东西(快照、价格、轮的进度)照旧落 D1,且各自幂等(同一小时同一账户
//     只一张快照、价格按键 upsert、轮的落账带轮 id 条件)—— 所以一件活跑了两次也没事。
//
// **为什么换**:免费计划的队列 consumer 每次调用只有 10ms CPU,而一条 `sync-account` 本地实测约 50ms;
// DO 每次调用(含 alarm)默认 30s CPU —— **免费计划上是不是也这么多,文档前后说法不一,要上线实测**
// (FOL-100;见 ADR 0058 的「前提」)。
//
// **只有一个实例**(`JOB_RUNNER_NAME`),所有用户的活排在一条线上:单线程、一件一件跑。自托管、用户少,
// 这是可接受的;真到了排不过来的那天,按用户分片是换个 `idFromName` 的事。

const log = getLogger(["folio", "jobs", "runner"]);

/** RPC 上传的一件活:消息体 + 延迟。与 `Enqueued` 同形(投递端就是把它原样递过来)。 */
type RunnerJob = Enqueued;

export class JobRunner extends DurableObject<Cloudflare.Env> {
  private readonly store: JobStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.store = new JobStore(ctx.storage.sql);
  }

  /** 排进去一批,并保证有一个不晚于最早那件的 alarm。 */
  async enqueue(jobs: readonly RunnerJob[]): Promise<void> {
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
   * cron 每次都戳一下:**不只靠 `getAlarm()`**。alarm 跑的那段时间里 `getAlarm()` 是 `null`,平台对一次
   * 抛错的 alarm 也只重试有限几次 —— 万一 alarm 链断了(实例重启撞上边界、某次设置没落上),活还在
   * 表里、却没人来跑。这里按表里的事实补一个 alarm,并在「有到点的活、上一次 alarm 很久以前」时记 warn。
   */
  async poke(): Promise<{ pending: number; dead: number }> {
    await configureLogging();
    const now = Date.now();
    const due = this.store.nextRunAt();
    const lastRan = this.store.lastRanAt();
    const counts = this.store.counts();
    if (due !== null && due <= now - RUNNER_STALL_MS && (lastRan ?? 0) <= now - RUNNER_STALL_MS) {
      log.warn("job runner looks stalled, re-arming", { ...counts, overdueMs: now - due });
    }
    await this.arm();
    return counts;
  }

  /**
   * 一次 alarm:跑一件到点的活,再按下一件定 alarm。**永远正常返回** —— 重试是运行器自己按指数退避排的
   * (`runOneDueJob`),不交给平台(平台对 alarm 只重试 6 次、间隔不由我们定)。
   */
  async alarm(): Promise<void> {
    await configureLogging();
    const now = Date.now();
    this.store.markRan(now);
    this.store.pruneDead(now - DEAD_JOB_RETENTION_MS);
    try {
      const { ran } = await runOneDueJob(this.store, (message) =>
        runAtEdge(consumeMessage(message)),
      );
      if (ran?.outcome === "buried") log.error("job buried after final attempt", { ...ran });
    } catch (err) {
      // 走到这里只可能是 store 自己的 SQL 出错(consumer 的异常 `runOneDueJob` 已经兜住)。
      log.error("job runner step threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await this.arm();
  }

  /**
   * 让 alarm 不晚于最早那件活。已经有一个更早的就不动;一件活都没有就不设。
   * 在 alarm 里调时 `getAlarm()` 是 `null`,于是照设 —— 那正是「跑完一件、接着下一件」要的。
   */
  private async arm(): Promise<void> {
    const due = this.store.nextRunAt();
    if (due === null) return;
    const at = Math.max(due, Date.now());
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}
