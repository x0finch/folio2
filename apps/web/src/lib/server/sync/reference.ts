import { Database, type DbRequest, type SnapshotWithBalances } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import type { ReferenceJob } from "@/lib/server/jobs/message";
import { forUser } from "@/lib/server/runtime";
import { recordDefiLogosOf } from "./defi-logos";
import { warmPlatforms } from "./platforms";

// 参考层预热里**不是持仓价**的那四件:汇率、平台元数据、目录、DeFi 协议图。best-effort,
// 让读路径(总览 / 选币 / 展示币种)能 cache-only 富化出汇率 / logo / 名。
//
// **只有队列这一个调用方**(FOL-88):一件一条消息(`runReferenceJob`),各自一份 10ms / 50 发的预算。
// 以前是一条 `warm-user` 包下四件,出网与 CPU 叠在一次调用里;手动同步的收尾(`warmTokens`)也曾在
// 自己那次 HTTP 调用里四件连做 —— FOL-89 起它也只是投这几条消息(`jobs/schedule` 的 `hourlyUserJobs`)。
//
// 四件的出网全在参考层里,各自按 TTL 门控、上游挂了各自降级(错误面都是 `never`),所以每件都幂等:
// 刚跑过再跑一遍,零出网(DeFi 图本来就不出网,重跑是同值覆盖写)。最坏出网数见
// `@/lib/server/jobs/constants` 的 `REFERENCE_JOB_UPSTREAM_CALLS`。

const log = getLogger(["folio", "jobs", "reference"]);

type Work = Effect.Effect<void, never, Database | Oracle | DbRequest>;

/** 汇率:全部支持币种一把拉(那个端点本来就一把给全),6h TTL 内零出网。 */
const refreshFx: Work = Effect.flatMap(Oracle, (o) => o.fx.warm());

/**
 * 目录(市值前 N):**唯一主动让它跟上的那条路**(#216)。写路径(mint)按设计永不刷,选币下拉只在
 * 用户打开时才刷 —— 从不开下拉的用户目录会冻住,此后新进前 1000 的币永远认不出来。
 * 内部按一周的 TTL 门控,绝大多数次零请求。
 */
const refreshCatalogue: Work = Effect.flatMap(Oracle, (o) => o.tokens.refreshCatalogue()).pipe(
  Effect.flatMap((rows) => Effect.sync(() => log.debug("catalogue warmed", { rows }))),
);

/** 读最新快照的那两件共用:跑的那一刻读一次。 */
const withLatest = (work: (snapshots: SnapshotWithBalances[]) => Work): Work =>
  Effect.flatMap(
    Effect.flatMap(Database, (db) => db.snapshots.latest()),
    work,
  );

// 只接 kind 的分派 —— 四条消息都只带 `userId`,userId 由 `forUser` 那层给。
const workOf = (kind: ReferenceJob["kind"]): Work => {
  switch (kind) {
    case "fx":
      return refreshFx;
    case "platforms":
      return withLatest(warmPlatforms);
    case "catalogue":
      return refreshCatalogue;
    case "defi-logos":
      return withLatest(recordDefiLogosOf);
  }
};

/**
 * 四件参考层活的 consumer。失败面只有 defect(D1 瞬时错、自家 bug)—— 上游的锅参考层已经降级掉了,
 * 所以这里失败就交给队列重投,不在这里吞。
 */
export const runReferenceJob = (job: ReferenceJob): Effect.Effect<void, Error> =>
  forUser(job.userId, workOf(job.kind));
