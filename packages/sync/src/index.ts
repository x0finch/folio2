// @folio/sync —— 同步编排。取账户 → 取余额(重试/超时)→ 认币 → 重估 → 写快照。
//
// 出口是 Promise(Effect 迁移中,ADR 0035):内部全是 Effect,这里 runPromise 一下,app 侧零改动。
// **Effect 版不对外导出** —— 包内模块(`./account` / `./sweep`)本来就是 Effect,包内的测试直接
// import 它们、自己 provide 服务即可,没必要为此把公开面翻一倍。下一步出口改成 Effect 时,
// 这里从「包一层壳」变成「直接 re-export」。
//
// 内部组织:`types` 公开类型 / `services` 能力与 Layer / `retry` 退避策略 /
// `account` 单账户 / `sweep` 单用户与全量。业务代码从上下文取能力,不透传 deps。

import type { AccountSafe } from "@folio/db";
import { Effect } from "effect";
import { syncAccount as accountEffect } from "./account";
import { layerFromDeps } from "./services";
import { syncAllUsers as allUsersEffect, syncUser as userEffect } from "./sweep";
import type { AccountSyncResult, SweepResult, SyncDeps, SyncResult } from "./types";

export { FetchBalancesError, SyncDepError, type SyncDepStep } from "./errors";
// 平台推导:写快照时用;app 侧采集 provider 元信息时也用同一条,免得两处口径分叉。
export { platformOf } from "./platform";
export type {
  AccountSyncResult,
  FetchOutcome,
  SweepResult,
  SyncDeps,
  SyncLogger,
  SyncResult,
} from "./types";

export const syncAccount = (
  deps: SyncDeps,
  userId: string,
  account: AccountSafe,
  rawCreds: string | null,
): Promise<AccountSyncResult> =>
  Effect.runPromise(
    accountEffect(userId, account, rawCreds).pipe(Effect.provide(layerFromDeps(deps))),
  );

export const syncUser = (deps: SyncDeps, userId: string): Promise<SyncResult> =>
  Effect.runPromise(userEffect(userId).pipe(Effect.provide(layerFromDeps(deps))));

export const syncAllUsers = (deps: SyncDeps, userIds: string[]): Promise<SweepResult> =>
  Effect.runPromise(allUsersEffect(userIds).pipe(Effect.provide(layerFromDeps(deps))));
