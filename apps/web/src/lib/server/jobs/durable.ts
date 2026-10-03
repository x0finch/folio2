import { DurableObject } from "cloudflare:workers";
import { getLogger } from "@logtape/logtape";
import { configureLogging } from "@/lib/server/entry/log";
import { runAtEdge } from "@/lib/server/runtime";
import { DEAD_JOB_RETENTION_MS, RUNNER_STALL_MS } from "./constants";
import { abandonMessage, consumeMessage } from "./consume";
import type { Enqueued } from "./queue";
import { alarmToSet, errorText, isStalled, runOneDueJob } from "./runner";
import { createJobStore, type JobStore } from "./store";

// **后台任务运行器**(FOL-100,ADR 0058):一个 SQLite 存储的 Durable Object,取代 FOL-86 的 Cloudflare 队列。
//
// 三个角色:
//   · cron / server fn 是**闹钟**:只往这里投活(`enqueue`)、或戳一下(`poke`),不干活。
//   · 这个 DO 是**调度 + 干活的那个**:活排在它自己的 SQLite 里(`store.ts`),alarm 一次跑一件
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

export class JobRunner extends DurableObject<Cloudflare.Env> {
  private readonly store: JobStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.store = createJobStore(ctx.storage.sql);
  }

  /** 排进去一批,并保证有一个不晚于最早那件的 alarm。 */
  async enqueue(jobs: readonly Enqueued[]): Promise<void> {
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
   * cron 每次都戳一下,**不只靠 `getAlarm()`**:alarm 跑的那段时间里它是 `null`,平台对一次抛错的 alarm
   * 也只重试有限几次 —— 万一 alarm 链断了(实例重启撞上边界、某次设置没落上),活还在表里、却没人来跑。
   * 判据是**自己记下的** alarm 时刻(`noteAlarm`):有到点的活,而自己定的那个 alarm 早该响过、却过了
   * `RUNNER_STALL_MS` 还没被下一次 alarm 刷新 → 记 warn,**不管 `getAlarm()` 怎么说**都把 alarm 重定到现在。
   * 埋掉的活也在这里清(一小时一次足够,不必每次 alarm 都跑一条 DELETE)。
   */
  async poke(): Promise<void> {
    await configureLogging();
    const now = Date.now();
    this.store.pruneDead(now - DEAD_JOB_RETENTION_MS);
    const due = this.store.nextRunAt();
    const stalled = isStalled({
      due,
      armedAt: this.store.alarmAt(),
      now,
      stallMs: RUNNER_STALL_MS,
    });
    if (stalled) {
      log.warn("job runner looks stalled, re-arming", {
        ...this.store.counts(),
        overdueMs: now - (due ?? now),
      });
    }
    await this.arm({ force: stalled });
  }

  /**
   * 一次 alarm:跑一件到点的活,再按下一件定 alarm。**永远正常返回、整段兜住** —— 重试是运行器自己按
   * 指数退避排的(`runOneDueJob`),不交给平台(平台对 alarm 只重试 6 次、间隔不由我们定)。
   */
  async alarm(): Promise<void> {
    try {
      await configureLogging();
      const { ran } = await runOneDueJob(this.store, {
        consume: (message) => runAtEdge(consumeMessage(message)),
        abandon: (message, reason) => runAtEdge(abandonMessage(message, reason)),
      });
      // 埋掉这件事 consumer 已经记过一条 error(`job failed on final attempt…` / `…never finished…`);
      // 这里只补它看不见的那一种:收尾那一步自己没跑成。
      if (ran?.abandonError) log.error("job give-up could not run", { ...ran });
    } catch (err) {
      // 走到这里只可能是 store 自己的 SQL 或日志初始化出错(consumer 的异常 `runOneDueJob` 已经兜住)。
      log.error("job runner step threw", { error: errorText(err) });
    }
    try {
      await this.arm();
    } catch (err) {
      // 定不上 alarm:活还在表里,下一次 cron 的 `poke` 会按自己记的时刻认出来、重定。
      log.error("job runner could not re-arm", { error: errorText(err) });
    }
  }

  /**
   * 让 alarm 不晚于最早那件活(判据见 `alarmToSet`;`force` 时不看 `getAlarm()`)。
   * 真定了才记下时刻 —— 没变化就不写。
   */
  private async arm({ force = false }: { force?: boolean } = {}): Promise<void> {
    const due = this.store.nextRunAt();
    if (due === null) return;
    const current = force ? null : await this.ctx.storage.getAlarm();
    const at = alarmToSet({ due, current, now: Date.now() });
    if (at === null) return;
    await this.ctx.storage.setAlarm(at);
    this.store.noteAlarm(at);
  }
}
