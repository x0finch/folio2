// @folio/sync —— 同步编排。取账户 → 取余额(重试/超时)→ 认币 → 重估 → 写快照。
//
// **两套出口并存**(Effect 迁移中,ADR 0035):
//   · `syncXxx`      —— Promise 壳,当前的正式出口,app 侧零改动
//   · `syncXxxEffect` —— Effect 版,给需要 Effect 上下文的场合(眼下是时序测试:假时钟挂不到壳上)
// 下一步出口改成 Effect 时,壳删掉、Effect 版转正。
//
// 内部组织:`contract` 公开契约 / `services` 能力与 Layer / `retry` 退避策略 /
// `account` 单账户 / `sweep` 单用户与全量。业务代码从上下文取能力,不透传 deps。

import type { AccountSafe } from "@folio/db";
import { Effect } from "effect";
import { syncAccount as accountEffect } from "./account";
import type { AccountSyncResult, SweepResult, SyncDeps, SyncResult } from "./contract";
import { layerFromDeps } from "./services";
import { syncAllUsers as allUsersEffect, syncUser as userEffect } from "./sweep";

export type {
  AccountSyncResult,
  FetchOutcome,
  SweepResult,
  SyncDeps,
  SyncLogger,
  SyncResult,
} from "./contract";
export { FetchBalancesError, SyncDepError, type SyncDepStep } from "./errors";
// 平台推导:写快照时用;app 侧采集 provider 元信息时也用同一条,免得两处口径分叉。
export { platformOf } from "./platform";

// Effect 版:依赖已由 deps 满足(内部 provide),所以 R = never —— 可直接组合、可挂假时钟。
export const syncAccountEffect = (
  deps: SyncDeps,
  userId: string,
  account: AccountSafe,
  rawCreds: string | null,
): Effect.Effect<AccountSyncResult> =>
  accountEffect(userId, account, rawCreds).pipe(Effect.provide(layerFromDeps(deps)));

export const syncUserEffect = (deps: SyncDeps, userId: string) =>
  userEffect(userId).pipe(Effect.provide(layerFromDeps(deps)));

export const syncAllUsersEffect = (deps: SyncDeps, userIds: readonly string[]) =>
  allUsersEffect(userIds).pipe(Effect.provide(layerFromDeps(deps)));

// Promise 壳。
export const syncAccount = (
  deps: SyncDeps,
  userId: string,
  account: AccountSafe,
  rawCreds: string | null,
): Promise<AccountSyncResult> =>
  Effect.runPromise(syncAccountEffect(deps, userId, account, rawCreds));

export const syncUser = (deps: SyncDeps, userId: string): Promise<SyncResult> =>
  Effect.runPromise(syncUserEffect(deps, userId));

export const syncAllUsers = (deps: SyncDeps, userIds: string[]): Promise<SweepResult> =>
  Effect.runPromise(syncAllUsersEffect(deps, userIds));
