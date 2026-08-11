import { SnapshotStore } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { Cause, Clock, Effect, Exit } from "effect";
import { withRequest } from "./oracle";

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

/** 一个用户的清理,**装配好了但还没跑**(cron 把 N 个用户拼进自己那一个 effect)。 */
const pruneNotesFor = (
  userId: string,
  olderThan: number,
): Effect.Effect<{ snapshots: number; balances: number }, Error> =>
  withRequest(
    userId,
    Effect.flatMap(SnapshotStore, (s) => s.pruneNotes(olderThan)),
  );

/**
 * 逐用户剪掉保留期外的展示 note,**各自兜住**(与 `warmAllUsers` 同一形状):一个用户失败不该让
 * 后面的用户排不上队,也不该把整次 cron 拖成异常收尾 —— 这是维护动作,不是正确性动作。
 *
 * **为什么不用 `Effect.partition`**:官方那几个错误累积算子内部是 `Effect.either`,只累积类型化
 * 失败,defect(我们自己抛的 TypeError、db 抛的东西)照样炸穿。`Effect.exit` 收整个 `Cause`,
 * 两类都进来。(同 `warmAllUsers` 的注释。)
 *
 * 时间走 `Clock` 而不是 `Date.now()`:测试要能把时钟推到窗口两侧,而不是靠改保留天数去凑。
 *
 * `pruneOne` 可注入,只为单测能让指定用户失败;生产路径用默认的 `pruneNotesFor`。
 */
export const pruneNotesAllUsers = (
  userIds: readonly string[],
  pruneOne: (
    userId: string,
    olderThan: number,
  ) => Effect.Effect<{ snapshots: number; balances: number }, Error> = pruneNotesFor,
): Effect.Effect<{ users: number; failed: number; snapshots: number; balances: number }> =>
  Effect.gen(function* () {
    const log = getLogger(["folio", "cron"]);
    const now = yield* Clock.currentTimeMillis;
    const olderThan = now - NOTE_RETENTION_DAYS * DAY_MS;
    const exits = yield* Effect.forEach(userIds, (userId) =>
      Effect.exit(pruneOne(userId, olderThan)),
    );
    let failed = 0;
    let snapshots = 0;
    let balances = 0;
    for (const exit of exits) {
      if (Exit.isSuccess(exit)) {
        snapshots += exit.value.snapshots;
        balances += exit.value.balances;
      } else {
        failed++;
        // 不带 userId(P6.7:日志只记 accountId/type/code/counts);「哪个用户」交给计数 + 汇总行。
        log.warn("prune notes failed, user skipped", { error: Cause.pretty(exit.cause) });
      }
    }
    return { users: userIds.length, failed, snapshots, balances };
  });
