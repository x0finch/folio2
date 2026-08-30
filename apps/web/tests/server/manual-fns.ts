import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { Effect } from "effect";
import { createAccountFor as createAccountForE } from "@/lib/server/accounts/create";
import type { AppError } from "@/lib/server/errors";
import * as M from "@/lib/server/manual/store";
import { runForUser, type UserServices } from "@/lib/server/runtime";

// **手记那一摞函数的 Promise 把手**(#394 T6)。它们本体现在都是 Effect(userId 由装配层吃掉,
// ADR 0037),而这些用例测的是**数据落库对不对** —— 真 D1、活动折叠、超支拒收、跨账户隔离,
// 跟时序无关。CODING.md / #391 那条判据说的就是这种:**按「测什么」分,不按包分**,
// 数据进出的保持 Promise 形状。`packages/db/tests/effect.ts` 的 `promisified` 是同一个东西。
//
// 每个把手都走**生产那条路**(`runForUser` → server fn / 路由用的同一个内核),不是第二条
// 构造路 —— 差别只在「一次调用装一次」而已,而这些用例本来就是那种粒度。
const run = <A, E extends AppError, R extends UserServices>(
  userId: string,
  effect: Effect.Effect<A, E, R>,
): Promise<A> => runForUser(userId, effect);

export const createManualAccount = (userId: string, label: string, tokens: string) =>
  run(userId, M.createManualAccount(label, tokens));

export const createAccountFor = (
  userId: string,
  ...args: Parameters<typeof createAccountForE>
): Promise<AccountSafe> => run(userId, createAccountForE(...args));

export const loadManualAccountDetail = (userId: string, accountId: string) =>
  run(userId, M.loadManualAccountDetail(accountId));

export const loadManualAccountSeries = (userId: string, accountId: string, now?: number) =>
  run(userId, M.loadManualAccountSeries(accountId, now));

export const loadManualAccountLiveTotal = (userId: string, accountId: string) =>
  run(userId, M.loadManualAccountLiveTotal(accountId));

export const loadManualHistoryRows = (userId: string, accounts: AccountSafe[], now?: number) =>
  run(userId, M.loadManualHistoryRows(accounts, now));

export const injectManualSnapshots = (
  userId: string,
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  takenAt?: number,
) => run(userId, M.injectManualSnapshots(accounts, byAccount, takenAt));

export const sealManualAccount = (userId: string, account: AccountSafe, takenAt?: number) =>
  run(userId, M.sealManualAccount(account, takenAt));

export const manualBalancesForWarm = (userId: string, accounts: AccountSafe[]) =>
  run(userId, M.manualBalancesForWarm(accounts));

export const createToken = (userId: string, input: M.CreateTokenInput) =>
  run(userId, M.createToken(input));

export const updateToken = (userId: string, input: M.UpdateTokenInput) =>
  run(userId, M.updateToken(input));

export const deleteToken = (userId: string, accountId: string, tokenId: string) =>
  run(userId, M.deleteToken(accountId, tokenId));

export const addManualActivities = (
  userId: string,
  ...args: Parameters<typeof M.addManualActivities>
) => run(userId, M.addManualActivities(...args));

export const deleteManualActivity = (userId: string, accountId: string, activityId: string) =>
  run(userId, M.deleteManualActivity(accountId, activityId));

export const editManualActivity = (
  userId: string,
  ...args: Parameters<typeof M.editManualActivity>
) => run(userId, M.editManualActivity(...args));
