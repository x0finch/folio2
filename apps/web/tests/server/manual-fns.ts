import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { Effect } from "effect";
import { createAccountFor as createAccountForE } from "@/lib/server/accounts/create";
import type { AppError } from "@/lib/server/errors";
import * as M from "@/lib/server/manual/store";
import { runForUser, type UserServices } from "@/lib/server/runtime";

// Production handler for each call (`runForUser`, the same core server fns and routes use), kept in
// Promise shape because these cases check persisted data, not timing.
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
