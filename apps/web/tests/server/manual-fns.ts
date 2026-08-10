import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import { createAccountFor as createAccountForE } from "../../src/lib/server/internal/create-account";
import * as M from "../../src/lib/server/internal/manual";
import { runRequest } from "../../src/lib/server/internal/oracle";

// **手记那一摞函数的 Promise 把手**(#394 T6)。它们本体现在都是 Effect(userId 由装配层吃掉,
// ADR 0037),而这些用例测的是**数据落库对不对** —— 真 D1、活动折叠、超支拒收、跨账户隔离,
// 跟时序无关。CODING.md / #391 那条判据说的就是这种:**按「测什么」分,不按包分**,
// 数据进出的保持 Promise 形状。`packages/db/tests/effect.ts` 的 `promisified` 是同一个东西。
//
// 每个把手都走**生产那条路**(`runRequest` → 同一份装配),不是第二条构造路 —— 差别只在
// 「一次调用装一次」而已,而这些用例本来就是那种粒度。
export const createManualAccount = (userId: string, label: string, tokens: string) =>
  runRequest(userId, M.createManualAccount(label, tokens));

export const createAccountFor = (
  userId: string,
  ...args: Parameters<typeof createAccountForE>
): Promise<AccountSafe> => runRequest(userId, createAccountForE(...args));

export const loadManualAccountDetail = (userId: string, accountId: string) =>
  runRequest(userId, M.loadManualAccountDetail(accountId));

export const loadManualAccountSeries = (userId: string, accountId: string, now?: number) =>
  runRequest(userId, M.loadManualAccountSeries(accountId, now));

export const loadManualAccountLiveTotal = (userId: string, accountId: string) =>
  runRequest(userId, M.loadManualAccountLiveTotal(accountId));

export const loadManualHistoryRows = (userId: string, accounts: AccountSafe[], now?: number) =>
  runRequest(userId, M.loadManualHistoryRows(accounts, now));

export const injectManualSnapshots = (
  userId: string,
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  takenAt?: number,
) => runRequest(userId, M.injectManualSnapshots(accounts, byAccount, takenAt));

export const sealManualAccount = (userId: string, account: AccountSafe, takenAt?: number) =>
  runRequest(userId, M.sealManualAccount(account, takenAt));

export const manualBalancesForWarm = (userId: string, accounts: AccountSafe[]) =>
  runRequest(userId, M.manualBalancesForWarm(accounts));

export const createToken = (userId: string, input: M.CreateTokenInput) =>
  runRequest(userId, M.createToken(input));

export const updateToken = (userId: string, input: M.UpdateTokenInput) =>
  runRequest(userId, M.updateToken(input));

export const deleteToken = (userId: string, accountId: string, tokenId: string) =>
  runRequest(userId, M.deleteToken(accountId, tokenId));

export const addManualActivities = (
  userId: string,
  ...args: Parameters<typeof M.addManualActivities>
) => runRequest(userId, M.addManualActivities(...args));

export const deleteManualActivity = (userId: string, accountId: string, activityId: string) =>
  runRequest(userId, M.deleteManualActivity(accountId, activityId));

export const editManualActivity = (
  userId: string,
  ...args: Parameters<typeof M.editManualActivity>
) => runRequest(userId, M.editManualActivity(...args));

export const loadManualGainHistory = (
  userId: string,
  accounts: AccountSafe[],
  now: number,
  since: number,
) => runRequest(userId, M.loadManualGainHistory(accounts, now, since));
