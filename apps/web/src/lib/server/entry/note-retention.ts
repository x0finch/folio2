import { Database } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { Clock, Effect } from "effect";
import type { PruneNotesJob } from "@/lib/server/jobs/message";
import { forUser } from "@/lib/server/runtime";

// 展示 note 的保留期(#456)。
//
// **为什么要有这件事**:note 的内容基本不变,却每次同步整份重写一遍 —— 实测带 note 的快照行
// 2225 字节、不带的 88 字节,差 25 倍。同步提到每小时之后(#446),一个 BTC xpub 账户每年约有
// 37 MB 在存同一份东西。
//
// **为什么是「剪旧」而不是「按内容去重」**(那是原来的方案,已否):
//   · 界面**从不读历史 note** —— 抽屉里那份来自 `latest()`,只取每账户最新那张;`listByAccount`
//     只取 takenAt/totalUsd 画曲线,压根不碰 note。历史 note 唯一的读者是**导出**。
//   · 去重要新表 + 新服务 + 三个指针列 + 改五条读路径 + 一次迁移,而且**管不了存量**
//     (去重键是 SHA-256,而 D1 没有哈希函数,迁移 SQL 里算不出来);剪旧是一条 UPDATE、
//     零迁移、零读路径改动,而且**顺手把存量一起清了**。
//   · 省得还更多:每小时同步一年 8760 张,去重按实测重复率剩约 891 KB,只留 7 天则约 359 KB。
//
// **7 天是怎么定的**:界面只需要 1 张,所以这个窗口纯粹留给导出 —— 导出文件里仍带着近一周的
// 上下文。再长只是多占空间(note 的历史价值接近零:它装的是「当时有几笔未确认」「收款地址是哪些」
// 这类**上游此刻状态**,不是财务数据);再短也只省零头。
//
// **只剪 note,不剪 `meta_json`**,以及**每账户最新那张永不剪** —— 这两条的理由在
// `SnapshotStore.pruneNotes` 的文档注释里(那是执行它们的地方),不在这儿重抄一遍。
const NOTE_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * `prune-notes` 的 consumer(FOL-88):剪掉**这一个用户**保留期外的展示 note。每天那个 cron 给每个用户
 * 投一条(`@/lib/server/jobs/schedule` 的 `fanOutDaily`)。以前是 cron 那一次调用里逐用户串行剪
 * (`pruneNotesAllUsers`),逐用户的失败隔离要自己兜;现在每个用户是自己的一次调用,隔离由队列给,
 * 失败(只会是 defect —— D1 挂了)交给队列重投。
 *
 * **幂等**:两条 UPDATE 都带 `note IS NOT NULL` 的门,重投 / 重复投递只会剪到 0 行。
 * 窗口在**跑的那一刻**按 `Clock` 算(不是投的那一刻):重投晚了 30 秒,窗口跟着挪 30 秒,无所谓。
 * 日志只带计数(P6.7)。
 */
export const runPruneNotesJob = (job: PruneNotesJob): Effect.Effect<void, Error> =>
  forUser(
    job.userId,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const pruned = yield* (yield* Database).snapshots.pruneNotes(
        now - NOTE_RETENTION_DAYS * DAY_MS,
      );
      getLogger(["folio", "jobs"]).info("prune notes done", pruned);
    }),
  );
