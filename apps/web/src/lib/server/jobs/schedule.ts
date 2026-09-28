import { Effect } from "effect";
import { AFTER_SYNC_DELAY_SECONDS } from "./constants";
import { type Enqueued, enqueue } from "./queue";

// **哪件活、多久投一次**(FOL-88)—— 两个 cron 投什么,只在这一处。
//
// **新鲜度判在 consumer 里,不在 cron 里。** 汇率 6h、平台一天、目录一周的 TTL 都由参考层自己门控
// (一次批量缓存读,新鲜就零出网),cron 照投。反过来在 cron 里先读一遍缓存再决定投不投,那次读
// 就落在 cron 那一次调用的 10ms 里,而且要逐用户读 —— consumer 那一侧本来就要读这一次,多投一条
// 消息的代价只是约 3 次队列操作(免费计划一天 10k)。所以「便宜地投、让 consumer 在新鲜时空跑」
// 对 cron 的 CPU 更省。
//
// 频率按「数据多快会变」挑,不按 TTL:
//   · 每小时(跟着同步):`prices`(FOL-87)、`fx`、`platforms` / `defi-logos`(读最新快照,所以
//     延后到同步落库之后)。汇率 TTL 6h、每小时投一次 → 最旧约 7h;平台 / DeFi 图要跟上这一轮
//     新出现的链与协议。
//   · 每天:`catalogue`(一周 TTL —— 每小时投一次是 167 条空跑换一次真刷,每天投一次最多晚一天刷)、
//     `prune-notes`(保留期按天算)。

/** 每小时 cron 给一个用户补的那几条(排在他的 `sync-account` 之后)。 */
export const hourlyUserJobs = (userId: string): Enqueued[] => [
  { job: { kind: "prices", userId } },
  { job: { kind: "fx", userId } },
  { job: { kind: "platforms", userId }, delaySeconds: AFTER_SYNC_DELAY_SECONDS },
  { job: { kind: "defi-logos", userId }, delaySeconds: AFTER_SYNC_DELAY_SECONDS },
];

/** 每天 cron 给一个用户投的那几条。 */
const dailyUserJobs = (userId: string): Enqueued[] => [
  { job: { kind: "prune-notes", userId } },
  { job: { kind: "catalogue", userId } },
];

/**
 * 每天那个 cron 的投递:每个用户一条 `prune-notes` + 一条 `catalogue`,**一批投完、不出网、不碰库**。
 * 以前剪 note 在 cron 那一次调用里逐用户串行跑(`pruneNotesAllUsers`);现在每个用户一条消息,
 * 逐用户的失败隔离由队列给(一条失败只重投它自己)。返回投了几条,给 cron 那行日志。
 */
export const fanOutDaily = (userIds: readonly string[]): Effect.Effect<{ jobs: number }> => {
  const batch = userIds.flatMap(dailyUserJobs);
  return Effect.as(enqueue(batch), { jobs: batch.length });
};
