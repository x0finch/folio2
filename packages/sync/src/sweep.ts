import { Effect } from "effect";
import { syncAccount } from "./account";
import { SYNC_CONCURRENCY } from "./constants";
import type { SweepResult, SyncResult } from "./contract";
import type { SyncDepError } from "./errors";
import { Accounts, SyncLog, type SyncServices } from "./services";

// 一个用户的一轮同步:批量读账户与凭据(各一次,消 N+1)→ 有界并发逐账户同步。
//
// 错误通道带 SyncDepError(step 为 listAccounts / listRawCreds)—— 这两步失败意味着**整个用户
// 这一轮没法开始**,所以向上抛,不像逐账户失败那样被隔离成 ok:false。
export const syncUser = (userId: string): Effect.Effect<SyncResult, SyncDepError, SyncServices> =>
  Effect.gen(function* () {
    const accountsSvc = yield* Accounts;
    // 两次读互不依赖 → 并发取。
    const [accounts, rawList] = yield* Effect.all(
      [accountsSvc.list(userId), accountsSvc.rawCreds(userId)],
      { concurrency: 2 },
    );
    const credsById = new Map(rawList.map((r) => [r.id, r.creds]));
    // 有界并发。**整条链留在同一个 Effect 里** —— 中间夹一层 runPromise 会切断上下文,
    // 假时钟就推不动各账户内部的退避(时序测试挂不上)。
    const results = yield* Effect.forEach(
      accounts,
      (account) => syncAccount(userId, account, credsById.get(account.id) ?? null),
      { concurrency: SYNC_CONCURRENCY },
    );
    return { results };
  });

// 定时全量 sweep(P6.3):逐用户同步、逐用户隔离(一个用户炸不影响其余;syncUser 内部已逐账户隔离)。
//
// **串行不是遗漏,是有意的**:cron 一次调用有 CPU / subrequest 预算,几十个用户并发会顶穿
// (见 apps/web server.ts 里两个 trigger 拆开的理由)。所以用 Effect.forEach 的默认串行语义,
// **别顺手加 concurrency** —— tests/sweep.test.ts 有一条专门钉这个。
export const syncAllUsers = (
  userIds: readonly string[],
): Effect.Effect<SweepResult, never, SyncServices> =>
  Effect.gen(function* () {
    const log = yield* SyncLog;
    let ok = 0;
    let failed = 0;
    let skipped = 0;
    yield* Effect.forEach(userIds, (userId) =>
      syncUser(userId).pipe(
        Effect.flatMap(({ results }) =>
          Effect.sync(() => {
            for (const r of results) {
              if (r.ok) ok++;
              else if (r.skipped)
                skipped++; // 缺凭据:不算失败
              else failed++; // 具体错误已在 syncAccount 以 error 级记录
            }
          }),
        ),
        // 用户级失败(取账户 / 取凭据挂了)不中断 sweep,计一个 failed 继续下一个。
        Effect.catchAll((err) =>
          Effect.sync(() => {
            failed++;
            log.error("user sweep threw", { userId, error: err.message });
          }),
        ),
      ),
    );
    return { users: userIds.length, ok, failed, skipped };
  });
