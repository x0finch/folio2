import type { Balance, ConnectorError } from "@folio/connectors-basic";
import type { AccountSafe } from "@folio/db";
import { Account, type AccountSyncResult, BalanceSource } from "@folio/sync";
import { Effect, Layer } from "effect";
import { runForUser } from "@/lib/server/runtime";
import { syncServicesLayer, warmTokens } from "@/lib/server/sync/deps";

// 同步的测试把手(#403 片 3)。`SyncDeps` 与 `buildSyncDeps` 没了 —— 编排现在从 `SyncServices`
// 取能力,所以测试要换掉的不再是「deps 对象上的一个字段」,而是**一层**。
//
// 只换「取余额」那一个能力:它是唯一会出网的一步。其余(账户、快照、认币、重估)都走真接线 +
// 真 D1,否则测的就不是这条路了。

export interface SyncJob {
  account: AccountSafe;
  rawCreds?: string | null;
  /** 这个账户这一轮报出来的余额;给 `fail` 则模拟取数失败。 */
  balances?: Balance[];
  fail?: ConnectorError;
}

const sourceFor = (job: SyncJob) =>
  Layer.succeed(BalanceSource, {
    fetch: () =>
      job.fail
        ? Effect.fail(job.fail)
        : Effect.succeed({
            status: "ok" as const,
            balances: job.balances ?? [],
            totalUsd: (job.balances ?? []).reduce((sum, b) => sum + b.value, 0),
          }),
  });

/**
 * **一轮同步**:多个账户共用一次装配。
 *
 * 这是生产里一轮同步的真实形状,也是这些用例原来靠「共用一份 `deps` 对象」表达的那件事 ——
 * seed 收集器与估值模式的存活范围就是这一轮。共用一层比共用一个对象更接近真相:它们本来
 * 就该同生同死。
 *
 * 账户**串行**跑(与 cron 的 sweep 一致);要测并发落同一个币,各起一轮即可(那也正是
 * 两个请求同时进来时的样子)。
 */
export const syncRound = (userId: string, jobs: SyncJob[]): Promise<AccountSyncResult[]> =>
  runForUser(
    "syncRound",
    userId,
    Effect.forEach(jobs, (job) =>
      Account.syncAccount(userId, job.account, job.rawCreds ?? null).pipe(
        Effect.provide(sourceFor(job)),
      ),
    ).pipe(Effect.provide(syncServicesLayer)),
  );

/** 一轮里就一个账户 —— 最常用的那一种。 */
export const syncOne = async (userId: string, job: SyncJob): Promise<AccountSyncResult> => {
  const [result] = await syncRound(userId, [job]);
  return result;
};

/**
 * 一个用户的预热,跑成 Promise。
 *
 * 生产里没有这个形状了(#504 T12):流式那条路把预热当**收尾 effect** 交给 `ndjsonRound`,
 * 与同步流共用同一次装配 —— 单独出一个「自己装一次再跑」的出口,正是那条路上曾经多建一个
 * `DbClient` 的原因。用例要的只是「跑一次预热看结果」,所以把手留在测试这边。
 */
export const warmTokensForUser = (userId: string): Promise<void> =>
  runForUser("warmTokens", userId, warmTokens);
