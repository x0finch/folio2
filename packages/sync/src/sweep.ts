import { Effect } from "effect";
import { syncAccountEffect } from "./account";
import { SYNC_CONCURRENCY } from "./constants";
import type { SyncDepError } from "./errors";
import { AccountStore, type SyncServices } from "./services";
import type { AccountSyncResult, SweepResult, SyncResult } from "./types";

// 一个用户的一轮同步:批量读账户与凭据(各一次,消 N+1)→ 有界并发逐账户同步。
//
// 错误通道带 SyncDepError(step 为 listAccounts / listRawCreds)—— 这两步失败意味着**整个用户
// 这一轮没法开始**,所以向上抛,不像逐账户失败那样被隔离成 ok:false。
export const syncUserEffect = (
  userId: string,
): Effect.Effect<SyncResult, SyncDepError, SyncServices> =>
  Effect.gen(function* () {
    const store = yield* AccountStore;
    // 两次读互不依赖 → 并发取。
    const [accounts, rawList] = yield* Effect.all([store.list(userId), store.rawCreds(userId)], {
      concurrency: 2,
    });
    const credsById = new Map(rawList.map((r) => [r.id, r.creds]));
    // 有界并发。**整条链留在同一个 Effect 里** —— 中间夹一层 runPromise 会切断上下文,
    // 假时钟就推不动各账户内部的退避(时序测试挂不上)。
    const results = yield* Effect.forEach(
      accounts,
      (account) => syncAccountEffect(userId, account, credsById.get(account.id) ?? null),
      { concurrency: SYNC_CONCURRENCY },
    );
    return { results };
  });

// 一个用户这一轮的账户计数。逐用户先各算各的,最后加总 —— 不在遍历里改外面的计数器。
type Tally = { readonly ok: number; readonly failed: number; readonly skipped: number };

const NO_ACCOUNTS: Tally = { ok: 0, failed: 0, skipped: 0 };
// 用户级失败(取账户 / 取凭据挂了):整个用户这轮没开始,计一个 failed。
const USER_FAILED: Tally = { ok: 0, failed: 1, skipped: 0 };

const tallyOf = (results: readonly AccountSyncResult[]): Tally =>
  results.reduce<Tally>(
    (t, r) => ({
      ok: t.ok + (r.ok ? 1 : 0),
      // 缺凭据:不算失败。
      skipped: t.skipped + (!r.ok && r.skipped ? 1 : 0),
      // 具体错误已在 syncAccountEffect 以 error 级记录。
      failed: t.failed + (!r.ok && !r.skipped ? 1 : 0),
    }),
    NO_ACCOUNTS,
  );

// 定时全量 sweep(P6.3):逐用户同步、逐用户隔离(一个用户炸不影响其余;syncUserEffect 内部已逐账户隔离)。
//
// **串行不是遗漏,是有意的**:cron 一次调用有 CPU / subrequest 预算,几十个用户并发会顶穿
// (见 apps/web server.ts 里两个 trigger 拆开的理由)。所以用 Effect.forEach 的默认串行语义,
// **别顺手加 concurrency** —— tests/sweep.test.ts 有一条专门钉这个。
export const syncAllUsersEffect = (
  userIds: readonly string[],
): Effect.Effect<SweepResult, never, SyncServices> =>
  Effect.forEach(userIds, (userId) =>
    syncUserEffect(userId).pipe(
      Effect.map(({ results }) => tallyOf(results)),
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
