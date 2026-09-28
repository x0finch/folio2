import {
  Database,
  type DbRequest,
  type OpenSyncRoundResult,
  type SyncRoundAccountStatus,
  type SyncRoundRecord,
  type SyncRoundTrigger,
} from "@folio/db";
import { type AccountSyncResult, Sweep } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { Cause, Chunk, Clock, Effect, Option, Stream } from "effect";
import { z } from "zod";
import { dataFreshness } from "@/lib/core/sync-status";
import type { SyncAccountJob } from "@/lib/server/jobs/message";
import { type Enqueued, enqueue } from "@/lib/server/jobs/queue";
import { hourlyUserJobs } from "@/lib/server/jobs/schedule";
import { scopedMembership } from "@/lib/server/portfolio/scope";
import { forUser } from "@/lib/server/runtime";
import { makeSyncServicesLayer, type SyncScope, syncRoundFor } from "./deps";
import { driveRound } from "./drive";
import { isSyncableAccount, type SyncRoundView, syncRoundView } from "./status";

// 一轮同步的**服务端事实**(ADR 0048):开轮、读进度,前端与 cron 共用这两个方法。
// 存哪儿、怎么写(带轮 id 条件的单语句)归 `@folio/db` 的 `syncRounds`;这里管的是
// 「一轮包含谁」「什么算活着」「怎么念给人听」。

/**
 * 心跳时长 —— **超时这件事只有这一个旋钮**。
 *
 * 「活着 = 不过期」,而续期有两条路:跑轮的任务每 `ROUND_KEEPALIVE_MS` 主动续一次(keepalive,
 * 这是手动轮的主保证 —— **与排队无关**),每个账户完成顺手也续。worker 真死了,两条路一起停,
 * 120s 后那一轮自然过期,下一次点同步开得动新轮。
 *
 * **队列跑的轮(cron,FOL-86)只有第二条路**:没有一条任务从头跑到尾,也就没有 keepalive —— 续期全靠
 * 每个 consumer 落账那一下。队列积压到两次落账之间超过 120s,面板会先说「中断」;晚到的落账仍带着
 * 同一个轮 id,照样落得上、照样续期、最后一个照样收官,只是那段时间里一次手动同步可以覆盖它。
 * 收下这个:单用户、个位数账户、`max_concurrency` 6 的队列,正常延迟是秒级。
 *
 * 120s 取的是「keepalive 间隔的两倍」——容得下丢一拍;它同时也盖得住单账户的最坏情形
 * (3 次尝试 × 20s 超时 + 退避 ≈ 70s)。**刻意不随名单大小变**:让它跟名单挂钩就等于
 * 每加一个账户都放宽一次「多久算死」。
 */
export const ROUND_HEARTBEAT_MS = 120_000;

/** keepalive 间隔 = 心跳的一半:丢一拍还有下一拍兜着,不至于擦着到期线。 */
const ROUND_KEEPALIVE_MS = ROUND_HEARTBEAT_MS / 2;

/**
 * 收官后的保留期。一轮收官之后它就只是「上一轮的报告」,而**下一轮开轮即覆盖** ——
 * 所以留多久只影响「多久不同步之后面板不再提上一轮」,一周足够长到没人碰得到它。
 */
export const ROUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 开一轮 —— 手动(`/api/sync`)与 cron 共用这一个。
 *
 * **这一轮跑哪些账户在这里定死**:当前组合的成员 ∧ 活跃 ∧ 非手记,判据与页头那份摘要同一个,
 * 所以面板上的 `x / N` 与这一轮真跑的条数是同一个数。
 *
 * **幂等在库那一层**(条件 upsert):这里照常算一份名单、生成一个轮 id 递下去,抢不到就把
 * 现场那一轮原样拿回来(`opened: false`)。所以「第二个设备点同步」和「cron 撞上手动」
 * 都不会把正在跑的那一轮清空重来。
 */
export const openSyncRound = (input: {
  portfolioId?: string;
  trigger: SyncRoundTrigger;
}): Effect.Effect<OpenSyncRoundResult, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const scope = yield* scopedMembership(input.portfolioId);
    const accounts = yield* db.accounts.list();
    return yield* db.syncRounds.open({
      portfolioId: scope.selectedId,
      roundId: crypto.randomUUID(),
      trigger: input.trigger,
      accounts: accounts
        .filter(isSyncableAccount)
        .filter((a) => scope.has(a.id))
        .map((a) => ({ id: a.id, label: a.label })),
      ttlMs: ROUND_HEARTBEAT_MS,
    });
  });

/**
 * 一个账户报回来的结果落成三档中的哪一档。
 *
 * **`skipped` 在这里只可能是「凭据没填完」**:另一种跳过是手记账户,而手记压根进不了一轮
 * (开轮的名单已经把它滤掉了)。所以这里不必再分一次 `skipReason` —— 真要有第三种跳过冒出来,
 * 它会显示成「需要凭据」,那时该改的是这一行,不是在面板上再猜一次。
 */
const statusOf = (r: AccountSyncResult): Exclude<SyncRoundAccountStatus, "pending"> =>
  r.ok ? "synced" : r.skipped ? "needs-keys" : "failed";

// 自动轮的「按新鲜度跳过」(FOL-18 子票 4)。把最新快照还**新鲜**(`dataFreshness === "fresh"`)的
// 账户当 `skipped` 直接收掉,返回这一轮**真正要问上游**的名单。手动轮不调它 —— 强制全量。
//
// **作为 `only` 的 Effect 形态交给装配层**(见 `SyncScope.only`):在同步轮那**同一次装配**里解析,
// 与同步内核共用一个 DbClient(红线:一次请求一个 DbClient),不另起一条根 fiber 建第二个连接。
// 解析时读一次 latest 快照,逐个 settle('skipped');被收掉的账户不进返回的名单,于是 Sweep 那条流
// 根本不 emit 它们,它们的 settle 这里已经写过,total 与 settled 仍对得上。
const planFreshSkips = (
  round: SyncRoundRecord,
): Effect.Effect<Set<string>, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* Clock.currentTimeMillis;
    const latest = yield* db.snapshots.latest();
    const takenAtById = new Map(latest.map((s) => [s.snapshot.accountId, s.snapshot.takenAt]));
    const toRun = new Set<string>();
    for (const id of Object.keys(round.accounts)) {
      const takenAt = takenAtById.get(id) ?? null;
      // 「新鲜」用组合级那同一个 `dataFreshness`(药丸转黄、进首页自动补一轮都共用它)—— 三处对
      // 「什么算新鲜」的判断不分叉:没同步过 / 超过 1 小时都照跑;时钟偏移的未来时间戳按 fresh 处理
      // (当刚同步过 → 跳过),不把未来当过期白问一遍上游。
      if (dataFreshness(takenAt, now) === "fresh") {
        yield* db.syncRounds.settle({
          portfolioId: round.portfolioId,
          roundId: round.roundId,
          accountId: id,
          status: "skipped",
          ttlMs: ROUND_HEARTBEAT_MS,
        });
      } else {
        toRun.add(id);
      }
    }
    return toRun;
  });

export interface RunSyncRoundOptions {
  /**
   * 自动轮(进首页补的那种,FOL-18 子票 4):先把数据还新的账户当 `skipped` 收掉,只问其余的上游。
   * 手动点同步不传 → 强制全量。两个标签页同时进首页仍只打一遍上游那件事由开轮幂等保证,这条管的是
   * 「一个自动轮内部,刚同步过的账户不再白问一遍」。
   */
  skipFresh?: boolean;
}

/**
 * 把开好的一轮真跑完 —— **调用方把返回的 Promise 交给 `waitUntil`**,它与任何连接都无关。
 *
 * 跑的名单直接取自那一轮记录(`Object.keys(round.accounts)`),不在这里按组合再算一遍:
 * 两份名单之间任何一点漂移都会让面板的 `x / N` 与真跑的条数对不上,而那种对不上是不报错的。
 *
 * 每个账户跑完写一次(顺带续心跳),整轮结束收一次官。**中途没人在看也照样跑完** ——
 * 这正是把状态搬到服务端换来的:以前「看」断了进度就没了,现在断的只是轮询。
 */
export const runSyncRound = async (
  userId: string,
  round: SyncRoundRecord,
  opts: RunSyncRoundOptions = {},
): Promise<void> => {
  const syncLog = getLogger(["folio", "web", "sync"]);
  // 自动轮按新鲜度跳过(FOL-18 子票 4):把 `planFreshSkips` 作为 `only` 的 **Effect 形态**交给装配层,
  // 在同步轮那**同一次装配**里解析(见 `SyncScope.only`)—— 与同步内核共用一个 DbClient,不再像从前
  // 那样另起一条 `runPromise` + `provide(userLayer)` 建第二个连接。规划只会以 defect 收场(错误面是
  // `never`),真炸了记一行、退回全量:跳过是优化,不能因它让一轮跑不成。手动轮直接全量,不走这一趟。
  const allIds = () => new Set(Object.keys(round.accounts));
  const only: SyncScope["only"] = opts.skipFresh
    ? planFreshSkips(round).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning(
            "skip-fresh planning failed; running full round",
            Cause.pretty(cause),
          ).pipe(Effect.as<ReadonlySet<string>>(allIds())),
        ),
      )
    : allIds();
  const { results, afterRound, layer } = syncRoundFor(userId, { only });
  const head = { portfolioId: round.portfolioId, roundId: round.roundId };
  return driveRound(results, {
    layer,
    afterRound: Effect.exit(afterRound),
    // 轮活着期间定时续心跳 —— settle 顺带的续期只在「一直有账在落」时才成立,排队时靠这条。
    keepalive: {
      intervalMs: ROUND_KEEPALIVE_MS,
      run: Effect.flatMap(Database, (db) =>
        db.syncRounds.touch({ ...head, ttlMs: ROUND_HEARTBEAT_MS }),
      ),
    },
    onResult: (r) =>
      Effect.flatMap(Database, (db) =>
        db.syncRounds.settle({
          ...head,
          accountId: r.accountId,
          status: statusOf(r),
          // 上游的原话只在真失败时留 —— 跳过的那些没有错误可言。
          error: r.ok || r.skipped ? undefined : r.error,
          ttlMs: ROUND_HEARTBEAT_MS,
        }),
      ),
    onDone: (error) =>
      Effect.flatMap(Database, (db) =>
        db.syncRounds.finish({
          ...head,
          error: error ?? undefined,
          retentionMs: ROUND_RETENTION_MS,
        }),
      ),
    onFatal: (error) => syncLog.error("sync round failed", { userId, error }),
  });
};

/**
 * cron 扫到一个用户时干的事:**按组合分区,一个组合一轮**(ADR 0048),**只开轮,不跑**(FOL-86)。
 *
 * 返回这一个用户要投的消息 —— 一个账户一条 `sync-account`;真同步在队列 consumer 里一条一次调用地跑
 * (`syncQueuedAccount`),每条各自一份 10ms CPU / 50 subrequest 的预算。以前这里在 cron 那一次
 * 调用里把全部账户跑完,生产上 42% 的整点 sweep 死在 exceededCpu。**这一步不出网**
 * (tests/server/sync/cron.cases.ts 钉着)。
 *
 * 为什么分区不会造成写放大:每个账户恰属一个组合(归属互斥,没有归属行的兜底进默认组合 ——
 * 与 `inView` 同一条判据),所以一个账户的完成事件只写它所属组合那一个键。
 * 键的形状与手动轮完全一致,于是 cron 的轮在面板上可见。
 *
 * **只投「这一轮是我开的」那些**:活轮还在(用户正好在手动同步)就别插一脚,开轮幂等会把
 * 那一轮原样还回来,`opened` 为假,cron 就跳过它。
 *
 * **空组合开的那一轮当场收官** —— 没有消息会去收它。少了这一步,120s 后那个组合的面板会挂着一句
 * 「中断」,而它根本没事。
 */
const fanOutUserRounds = (userId: string): Effect.Effect<Enqueued[], Error> =>
  Effect.gen(function* () {
    const db = yield* Database;
    // **一次快照,一次分区。** 逐组合调 `openSyncRound` 会把成员表 / 账户表读 P 遍(P = 组合数),
    // 而且循环中途有人移动账户的话,同一个账户可能进两轮或一轮都不进 —— 同一时刻的快照把这个
    // 窗口一并消掉。归属判据仍是 `inView` 那一条:没有归属行的兜底进默认组合(它必须先存在,
    // 否则那些账户这一轮谁都不管)。
    const defaultPf = yield* db.portfolios.ensureDefault();
    const [portfolios, memberships, accounts] = yield* Effect.all(
      [db.portfolios.list(), db.portfolios.listMemberships(), db.accounts.list()],
      { concurrency: 3 },
    );
    const portfolioOf = new Map(memberships.map((m) => [m.accountId, m.portfolioId]));
    const rosters = new Map<string, { id: string; label: string }[]>(
      portfolios.map((pf) => [pf.id, []]),
    );
    for (const a of accounts.filter(isSyncableAccount)) {
      const home = portfolioOf.get(a.id) ?? defaultPf.id;
      // 归属行指着一个已删的组合在 FK cascade 下不会发生;真发生了宁可跳过也别把轮开到没人读的键上。
      rosters.get(home)?.push({ id: a.id, label: a.label });
    }
    const opened = yield* Effect.forEach(portfolios, (pf) =>
      db.syncRounds.open({
        portfolioId: pf.id,
        roundId: crypto.randomUUID(),
        trigger: "cron",
        accounts: rosters.get(pf.id) ?? [],
        ttlMs: ROUND_HEARTBEAT_MS,
      }),
    );
    const mine = opened.flatMap((o) => (o.opened ? [o.round] : []));
    const jobs: Enqueued[] = [];
    for (const round of mine) {
      const ids = Object.keys(round.accounts);
      if (ids.length === 0) {
        yield* db.syncRounds.finish({
          portfolioId: round.portfolioId,
          roundId: round.roundId,
          retentionMs: ROUND_RETENTION_MS,
        });
        continue;
      }
      for (const accountId of ids) {
        jobs.push({
          job: {
            kind: "sync-account",
            userId,
            portfolioId: round.portfolioId,
            roundId: round.roundId,
            accountId,
          },
        });
      }
    }
    return jobs;
  }).pipe((work) => forUser(userId, work));

/** cron 那一趟的小计:投了多少条、几个用户没投成。**同步的成败不在这里** —— 它们还没跑。 */
export interface FanOutResult {
  users: number;
  /** 投出去的 `sync-account` 条数(= 这一小时要同步的账户数)。 */
  accounts: number;
  /** 开轮 / 投递那一步就炸了的用户数。 */
  failed: number;
}

/**
 * cron 的全量 sweep:**逐用户串行**开轮、投消息,再补上 `hourlyUserJobs` 那几条(`prices` / `fx`
 * 不延后,读快照的 `platforms` / `defi-logos` 延后到同步落库之后,FOL-88)。
 *
 * **`prices` 与 `sync-account` 同时投,不排先后**(FOL-87)。同步的重估只读价表,所以这一轮的快照
 * 可能用上一轮刷的价(最多约一小时旧,展示层照样按价表现价重算,影响的只是快照里冻的那一格 value)。
 * 反过来让同步等价刷完(同步延后投)也做得到,但延后的是用户看得见的同步进度,换来的只是
 * 快照 value 新一点 —— 不值。`prices` 读的持仓 id 也来自最新快照:这一轮新出现的币下一轮才刷上价,
 * 在那之前按自带价 / provider 原值估(`revalue` 的回退)。
 *
 * **串行不是遗漏**:这一趟现在只剩 D1 读写与投递,但它仍是一次调用、仍有一份预算 —— 用户多了
 * 该拆的是「投一条 per-user 的开轮消息」,不是在这里并发。
 *
 * **逐用户各自兜住,而且兜的是 Cause**:失败面全是 defect(db / 装配 / 投递炸了),`catchAll`
 * 接不住 —— 不兜的话,一个坏用户会让排在他后面的所有人这一小时都不同步。只记 error 不记 userId(P6.7)。
 *
 * `fanOutOne` 可注入,只为单测能观察到「一个跑完才起下一个」、能让指定用户失败。
 */
export const fanOutAllUsers = (
  userIds: readonly string[],
  fanOutOne: (userId: string) => Effect.Effect<Enqueued[], Error> = fanOutUserRounds,
): Effect.Effect<FanOutResult> =>
  Effect.forEach(userIds, (userId) =>
    fanOutOne(userId).pipe(
      // 同步之后的那几件(价 / 汇率 / 平台 / DeFi 图)各一条、各一份预算;投什么、延不延后
      // 在 `hourlyUserJobs` 一处(FOL-88)。
      Effect.map((jobs): Enqueued[] => [...jobs, ...hourlyUserJobs(userId)]),
      Effect.tap(enqueue),
      Effect.map((batch) => ({
        accounts: batch.filter((m) => m.job.kind === "sync-account").length,
        failed: 0,
      })),
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          getLogger(["folio", "cron"]).warn("user fan-out failed, user skipped", {
            error: Cause.pretty(cause),
          });
          return { accounts: 0, failed: 1 };
        }),
      ),
    ),
  ).pipe(
    Effect.map((per) => ({
      users: userIds.length,
      accounts: per.reduce((n, p) => n + p.accounts, 0),
      failed: per.reduce((n, p) => n + p.failed, 0),
    })),
  );

// —— 队列 consumer 那一侧(FOL-86)——

// 「这条消息还该跑吗」:键上还是这一轮、还没收官、这个账户还没落账。三条都要 ——
// 队列 at-least-once(同一条可能投两遍)、手动轮可能已经覆盖了键、轮可能已被判中断后重开。
const stillPending = (round: Option.Option<SyncRoundRecord>, job: SyncAccountJob): boolean =>
  Option.exists(
    round,
    (r) =>
      r.roundId === job.roundId &&
      r.finishedAt === null &&
      r.accounts[job.accountId]?.status === "pending",
  );

/**
 * 落一个账户的账,**是最后一个就收官**(`finishIfSettled`:一条条件 UPDATE,并发的两个 consumer
 * 只有一个抢得到)。收官那一刻念一行小计 —— 以前 cron 在一次调用里跑完所有轮再念,现在没有
 * 「一次调用跑完」这件事了,念小计的只能是收官的那一个。
 */
const settleQueued = (
  job: SyncAccountJob,
  outcome: { status: Exclude<SyncRoundAccountStatus, "pending">; error?: string },
): Effect.Effect<void, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const head = { portfolioId: job.portfolioId, roundId: job.roundId };
    yield* db.syncRounds.settle({
      ...head,
      accountId: job.accountId,
      ...outcome,
      ttlMs: ROUND_HEARTBEAT_MS,
    });
    const finished = yield* db.syncRounds.finishIfSettled({
      ...head,
      retentionMs: ROUND_RETENTION_MS,
    });
    if (Option.isNone(finished)) return;
    const view = syncRoundView(finished.value, yield* Clock.currentTimeMillis);
    getLogger(["folio", "jobs"]).info("queued round done", {
      portfolioId: job.portfolioId,
      trigger: finished.value.trigger,
      state: view.state,
      total: view.total,
      synced: view.synced,
      failed: view.failed.length,
      needsKeys: view.needsKeys,
      unresolved: view.unresolved,
    });
  });

/**
 * `sync-account` 的 consumer:**同步恰好这一个账户**,落账,够了就收官。
 *
 * 同步走的是**同一个内核**(`Sweep.syncUserStream` + `makeSyncServicesLayer`,`only` 收口成这一个
 * 账户)—— 取余额 / 重试 / 认币 / 重估 / 写快照与手动轮逐字相同,不另写一条单账户的路。
 * 名单里没它了(两次投递之间被归档 / 删掉)→ 记成 `skipped`:它不是失败,只是这一轮没事可做。
 *
 * 逐账户的失败(上游挂了、缺凭据)在内核里已经收成 `failed` / `needs-keys`,**不走队列重试**。
 * 这里只会以 defect 或 `SyncDepError`(取账户 / 取凭据那两步)失败 —— 那种才交给队列重投。
 */
export const syncQueuedAccount = (job: SyncAccountJob): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const db = yield* Database;
    if (!stillPending(yield* db.syncRounds.get(job.portfolioId), job)) {
      getLogger(["folio", "jobs"]).info("stale sync job skipped", { accountId: job.accountId });
      return;
    }
    const results = yield* Sweep.syncUserStream(job.userId).pipe(
      Stream.runCollect,
      Effect.provide(makeSyncServicesLayer({ only: new Set([job.accountId]) })),
    );
    yield* settleQueued(
      job,
      Option.match(Chunk.head(results), {
        onNone: () => ({ status: "skipped" as const }),
        onSome: (r) => ({
          status: statusOf(r),
          // 上游的原话只在真失败时留 —— 跳过的那些没有错误可言。
          error: r.ok || r.skipped ? undefined : r.error,
        }),
      }),
    );
  }).pipe((work) => forUser(job.userId, work));

/**
 * 最后一次投递也失败了:**把这个账户记成 failed、够了就收官**,别让它在轮里永远 pending
 * (那样面板要等心跳过期才说「中断」,而且说的是整轮)。`reason` 是那次失败的一句话。
 */
export const giveUpQueuedAccount = (
  job: SyncAccountJob,
  reason: string,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const db = yield* Database;
    if (!stillPending(yield* db.syncRounds.get(job.portfolioId), job)) return;
    yield* settleQueued(job, { status: "failed", error: reason });
  }).pipe((work) => forUser(job.userId, work));

// 收一个 portfolioId:选中态只在客户端,服务端没有第二条路知道你在看哪个组合。
export const GetSyncRoundInput = z.object({ portfolioId: z.string().min(1) });

/**
 * 读这个组合最近一轮。**没有过 → `null`**,不是一个空轮 ——「从没同步过」与「刚开了一轮、
 * 一个账户都还没跑完」在面板上要说的话完全不同。
 *
 * 这是 busy 期间 1.5s 一发的那一条 —— 轮询盯的是唯一在变的东西;页头摘要改在浏览器由
 * accounts + snapshots 派生(FOL-58),不反复重算只有落库才变的那份。
 */
export const handleGetSyncRound = Effect.fn("getSyncRound")(function* (
  data: z.infer<typeof GetSyncRoundInput>,
) {
  const db = yield* Database;
  // **不先解析组合归属,直接读键**:这是 busy 期间 1.5s 一发的路,解析要多两条查询,而键本身
  // 就是 user-scoped 的 —— 一个认不出的 portfolioId 只会读到一个空键,回 none,不泄露任何东西。
  // 客户端传来的永远是选择器里真实存在的 id(usePortfolio 先校验过);开轮那头对坏 id 退回
  // 默认组合,是因为**开轮**必须落在一个真组合上,读不需要这个保证。
  const round = yield* db.syncRounds.get(data.portfolioId);
  const now = yield* Clock.currentTimeMillis;
  return Option.match(round, {
    onNone: () => null,
    onSome: (r): SyncRoundView | null => syncRoundView(r, now),
  });
});
