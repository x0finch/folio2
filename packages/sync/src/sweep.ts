import { Chunk, Effect, Stream } from "effect";
import { syncAccountEffect } from "./account";
import { SYNC_CONCURRENCY } from "./constants";
import type { SyncDepError } from "./errors";
import { AccountStore, type SyncServices } from "./services";
import type { AccountSyncResult, SweepResult, SyncResult } from "./types";

// 一个用户的一轮同步,**逐账户产出结果**。
//
// 为什么是流不是「跑完给个数组」:主页的「立即同步」要边跑边给用户看进度。攒到最后再一次性返回,
// 用户就只能对着转圈等 —— 账户多的时候是几十秒。
//
// `unordered: true` 是有意的:**先完成先报**。保序的话快账户要等慢账户,进度条会一卡一卡地跳,
// 那就白开流了。代价是收集成数组时顺序不定 —— 调用方按 accountId 认,别按下标。
//
// 错误通道带 SyncDepError(step 为 listAccounts / listRawCreds)—— 这两步失败意味着**整个用户
// 这一轮没法开始**,所以向上抛,不像逐账户失败那样被隔离成 ok:false。
//
// 名字带 `Effect` 后缀的口径同兄弟几个:**指「依赖还没接上」那一版**(R 里还有 SyncServices),
// 不是说它返回 Effect —— 它返回 Stream。接上依赖的那一版在 index.ts,叫 `syncUserStream`。
export const syncUserStreamEffect = (
  userId: string,
): Stream.Stream<AccountSyncResult, SyncDepError, SyncServices> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* AccountStore;
      // 两次读互不依赖 → 并发取。都拿到了才知道要同步哪些账户,所以这段在流开始之前。
      const [accounts, rawList] = yield* Effect.all([store.list(userId), store.rawCreds(userId)], {
        concurrency: 2,
      });
      const credsById = new Map(rawList.map((r) => [r.id, r.creds]));
      // 有界并发。**整条链留在同一个 Effect / Stream 里** —— 中间夹一层 runPromise 会切断上下文,
      // 假时钟就推不动各账户内部的退避(时序测试挂不上)。
      return Stream.fromIterable(accounts).pipe(
        Stream.mapEffect(
          (account) => syncAccountEffect(userId, account, credsById.get(account.id) ?? null),
          { concurrency: SYNC_CONCURRENCY, unordered: true },
        ),
      );
    }),
  );

// 同上,但等全部跑完再给一份完整结果。给不需要进度的调用方(以及测试)。
export const syncUserEffect = (
  userId: string,
): Effect.Effect<SyncResult, SyncDepError, SyncServices> =>
  syncUserStreamEffect(userId).pipe(
    Stream.runCollect,
    Effect.map((chunk) => ({ results: Chunk.toArray(chunk) })),
  );

// 一个用户这一轮的账户计数。**逐条折进去**,不在遍历里改外面的计数器 —— 也正好配流:
// cron 只要计数,没必要把几十个用户的逐账户结果全攒在内存里。
type Tally = { readonly ok: number; readonly failed: number; readonly skipped: number };

const NO_ACCOUNTS: Tally = { ok: 0, failed: 0, skipped: 0 };
// 用户级失败(取账户 / 取凭据挂了):整个用户这轮没开始,计一个 failed。
const USER_FAILED: Tally = { ok: 0, failed: 1, skipped: 0 };

const addResult = (t: Tally, r: AccountSyncResult): Tally => ({
  ok: t.ok + (r.ok ? 1 : 0),
  // 缺凭据:不算失败。
  skipped: t.skipped + (!r.ok && r.skipped ? 1 : 0),
  // 具体错误已在 syncAccountEffect 以 error 级记录。
  failed: t.failed + (!r.ok && !r.skipped ? 1 : 0),
});

// 定时全量 sweep(P6.3):逐用户同步、逐用户隔离(一个用户炸不影响其余;单账户失败在更里面已隔离)。
//
// **串行不是遗漏,是有意的**:cron 一次调用有 CPU / subrequest 预算,几十个用户并发会顶穿
// (见 apps/web server.ts 里两个 trigger 拆开的理由)。所以用 Effect.forEach 的默认串行语义,
// **别顺手加 concurrency** —— tests/sweep.test.ts 有一条专门钉这个。
//
// 消费的是流而不是收集好的数组:cron 只要计数,没必要把几十个用户的逐账户结果全攒在内存里。
export const syncAllUsersEffect = (
  userIds: readonly string[],
): Effect.Effect<SweepResult, never, SyncServices> =>
  Effect.forEach(userIds, (userId) =>
    // 折叠流:一条结果进来就并进小计,不留数组。
    Stream.runFold(syncUserStreamEffect(userId), NO_ACCOUNTS, addResult).pipe(
      // 用户级失败不中断 sweep,记一笔继续下一个。
      Effect.catchAll((err) =>
        Effect.logError("user sweep threw").pipe(
          Effect.annotateLogs({ userId, error: err.message }),
          Effect.as(USER_FAILED),
        ),
      ),
    ),
  ).pipe(
    Effect.map((tallies) =>
      tallies.reduce<SweepResult>(
        (acc, t) => ({
          users: acc.users,
          ok: acc.ok + t.ok,
          failed: acc.failed + t.failed,
          skipped: acc.skipped + t.skipped,
        }),
        { users: userIds.length, ...NO_ACCOUNTS },
      ),
    ),
  );
