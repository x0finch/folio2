import {
  Database,
  type SyncRoundAccountStatus,
  type SyncRoundRecord,
  type SyncRoundTrigger,
} from "@folio/db";
import { type AccountSyncResult, Sweep, type SweepResult, SYNC_CONCURRENCY } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { Clock, Effect, Option } from "effect";
import { z } from "zod";
import { resolveScope, scopedMembership } from "@/lib/server/portfolio/scope";
import { userLayer } from "@/lib/server/runtime";
import { syncRoundFor } from "./deps";
import { driveRound } from "./drive";
import { isSyncableAccount, type SyncRoundView, syncRoundView } from "./status";

// 一轮同步的**服务端事实**(ADR 0048):开轮、读进度,前端与 cron 共用这两个方法。
// 存哪儿、怎么写(带轮 id 条件的单语句)归 `@folio/db` 的 `syncRounds`;这里管的是
// 「一轮包含谁」「什么算活着」「怎么念给人听」。

/**
 * 心跳时长 —— **超时这件事只有这一个旋钮**。
 *
 * 开轮写 `now + 120s`,每个账户完成顺手续到 `now + 120s`;worker 死了,最后一次心跳 120s 后
 * 那一轮自然过期,于是下一次点同步开得动新轮。
 *
 * 120s 是照**单个账户**的最坏情形取的:3 次尝试 × 20s 超时 + 退避 ≈ 70s,圆整上去。
 * **刻意不随名单大小变** —— 一轮几十个账户也只是「一个接一个地续期」,总时长不进这个数;
 * 让它跟名单挂钩就等于每加一个账户都放宽一次「多久算死」。
 */
export const ROUND_HEARTBEAT_MS = 120_000;

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
}): Effect.Effect<{ round: SyncRoundRecord; opened: boolean }, never, Database> =>
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

export interface RunSyncRoundOptions {
  /**
   * 出网的闸,**同一个用户的多轮共用一把**。cron 按组合分区开轮(ADR 0048),一个用户可能
   * 同时有好几轮在跑 —— 没有这把闸,「每用户最多 6 发上游」就变成「每轮 6 发」。
   */
  gate?: Effect.Semaphore;
  /**
   * 跑完顺手预热代币缓存(供下次总览 cache-only 富化新价)。
   *
   * **cron 关掉它**:预热是**按用户一次**的事,而 cron 一个用户可能开好几轮 —— 每轮都热一遍
   * 就是同样几发上游白打好几次(CoinGecko 免费档一分钟只有十发)。cron 的预热在 sweep 收尾
   * 统一做(`warmAllUsers`)。
   */
  warm?: boolean;
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
export const runSyncRound = (
  userId: string,
  round: SyncRoundRecord,
  opts: RunSyncRoundOptions = {},
): Promise<void> => {
  const syncLog = getLogger(["folio", "web", "sync"]);
  const { results, afterRound, layer } = syncRoundFor(userId, {
    only: new Set(Object.keys(round.accounts)),
    gate: opts.gate,
  });
  const head = { portfolioId: round.portfolioId, roundId: round.roundId };
  return driveRound(results, {
    layer,
    afterRound: opts.warm === false ? undefined : afterRound,
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

const NO_ACCOUNTS: Sweep.Tally = { ok: 0, failed: 0, skipped: 0 };

/**
 * cron 扫到一个用户时干的事:**按组合分区,一个组合一轮**(ADR 0048)。
 *
 * 为什么分区不会造成写放大:每个账户恰属一个组合(归属互斥,没有归属行的兜底进默认组合 ——
 * 与 `inView` 同一条判据),所以一个账户的完成事件只写它所属组合那一个键。
 * 键的形状与手动轮完全一致,于是 **cron 的轮从此在面板上可见** —— 以前它对面板永远隐形。
 *
 * **只跑「这一轮是我开的」那些**:活轮还在(用户正好在手动同步)就别插一脚,开轮幂等会把
 * 那一轮原样还回来,`opened` 为假,cron 就跳过它。
 *
 * **空组合开的那一轮照样要跑** —— 跑它等于立刻收官(流一条都不产出)。看起来多此一举,
 * 少了它才是错的:开了轮却不收官,120s 后那个组合的面板会挂着一句「中断」,而它根本没事。
 *
 * **一个用户一把闸**:多个组合并发跑,但这个用户同时在飞的上游请求仍是 `SYNC_CONCURRENCY` 个。
 * 没有它,「每用户最多 6 发」会随组合数翻倍,而 cron 一次调用的 subrequest 预算是有限的。
 *
 * 小计**从收官后的轮记录读回来**,不在旁边再攒一份:那份记录就是这一轮的账本,而两份账
 * (一份攒在内存里、一份写在库里)只会在某天对不上。
 */
const syncUserRounds = (userId: string): Effect.Effect<Sweep.Tally> =>
  Effect.gen(function* () {
    const cronLog = getLogger(["folio", "cron"]);
    const db = yield* Database;
    // 没有归属行的账户兜底进默认组合,所以它必须先存在,否则那些账户这一轮谁都不管。
    yield* db.portfolios.ensureDefault();
    const portfolios = yield* db.portfolios.list();
    const opened = yield* Effect.forEach(portfolios, (pf) =>
      openSyncRound({ portfolioId: pf.id, trigger: "cron" }),
    );
    const mine = opened.filter((o) => o.opened).map((o) => o.round);
    const gate = Effect.unsafeMakeSemaphore(SYNC_CONCURRENCY);
    yield* Effect.forEach(
      mine,
      (round) => Effect.promise(() => runSyncRound(userId, round, { gate, warm: false })),
      { concurrency: "unbounded" },
    );

    const now = yield* Clock.currentTimeMillis;
    let tally = NO_ACCOUNTS;
    for (const round of mine) {
      const back = yield* db.syncRounds.get(round.portfolioId);
      // 键上已经不是这一轮了(理论上要 120s 内又开一轮)—— 那份账本不归我念。
      const settled = Option.filter(back, (r) => r.roundId === round.roundId);
      if (Option.isNone(settled)) continue;
      const view = syncRoundView(settled.value, now);
      cronLog.info("cron round done", {
        portfolioId: round.portfolioId,
        state: view.state,
        total: view.total,
        synced: view.synced,
        failed: view.failed.length,
        needsKeys: view.needsKeys,
      });
      tally = {
        ok: tally.ok + view.synced,
        failed: tally.failed + view.failed.length,
        skipped: tally.skipped + view.needsKeys,
      };
    }
    return tally;
  }).pipe(Effect.provide(userLayer(userId)), Effect.annotateLogs({ userId }));

/**
 * cron 的全量 sweep:**逐用户串行**,再把小计加起来。
 *
 * 这个循环以前住在 `@folio/sync` 的壳里。服务变成 per-user 之后它就不该在包里了 ——
 * 一份服务服务不了多个用户,「逐用户装配 + 累加」属于做装配的这一方。
 *
 * **串行不是遗漏,是有意的**:cron 一次调用有 CPU / subrequest 预算,几十个用户并发会顶穿
 * (见 server.ts 里两个 trigger 拆开的理由)。用 `Effect.forEach` 的默认串行语义,
 * **别顺手加 concurrency** —— 一个用户**内部**按组合并发是另一回事,那一层有闸拦着。
 *
 * `syncOne` 可注入,只为单测能观察到「一个跑完才起下一个」—— 与 `warmAllUsers` 同款理由。
 * 这个钩子是必要的:循环从 `@folio/sync` 搬过来之后,包里那条串行用例钉的是它自己那份复刻,
 * **在这里加并发它照样绿**。钉子得跟着被钉的东西走。
 */
export const syncAllUsers = (
  userIds: readonly string[],
  syncOne: (userId: string) => Effect.Effect<Sweep.Tally> = syncUserRounds,
): Effect.Effect<SweepResult, never> =>
  Effect.forEach(userIds, syncOne).pipe(
    Effect.map((tallies) => Sweep.sumTallies(userIds.length, tallies)),
  );

// 收一个 portfolioId 的理由与 `getSyncStatus` 同一条:选中态只在客户端,服务端没有第二条路
// 知道你在看哪个组合。
export const GetSyncRoundInput = z.object({ portfolioId: z.string().min(1) });

/**
 * 读这个组合最近一轮。**没有过 → `null`**,不是一个空轮 ——「从没同步过」与「刚开了一轮、
 * 一个账户都还没跑完」在面板上要说的话完全不同。
 *
 * 这是 busy 期间 1.5s 一发的那一条,所以它只读一个键:摘要(`getSyncStatus`)照旧低频,
 * 轮询盯的是唯一在变的东西,不反复重算只有落库才变的那份。
 */
export const handleGetSyncRound = Effect.fn("getSyncRound")(function* (
  data: z.infer<typeof GetSyncRoundInput>,
) {
  const db = yield* Database;
  // 与开轮同一条解析:客户端传来的 id 认不出就退回默认组合,两边必须落在同一个键上。
  const { selectedId } = yield* resolveScope(data.portfolioId);
  const round = yield* db.syncRounds.get(selectedId);
  const now = yield* Clock.currentTimeMillis;
  return Option.match(round, {
    onNone: () => null,
    onSome: (r): SyncRoundView | null => syncRoundView(r, now),
  });
});
