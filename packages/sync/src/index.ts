// @folio/sync —— 同步编排。取账户 → 取余额(重试/超时)→ 认币 → 重估 → 写快照。
//
// 出口(Effect 迁移中,ADR 0035):内部全是 Effect,这里把依赖接上再交给调用方。
//   · `syncAccount` / `syncUser` / `syncAllUsers` —— Promise,跑完给结果
//   · `syncUserStream` —— 流,逐账户产出,给要边跑边显示进度的调用方
// 公开面只留真有消费者的;包内测试直接 import `./account` / `./sweep` 自己 provide,不走这里。
//
// 内核带 `Effect` 后缀、壳不带,后缀写在**定义**上而不是 import 时现起别名 —— 于是全包只有
// 一套名字,`syncUserEffect` 走到哪都叫这个,读的人不用回头查它在别处叫什么。
//
// 内部组织:`types` 公开类型 / `services` 能力与 Layer / `retry` 退避策略 /
// `account` 单账户 / `sweep` 单用户与全量。业务代码从上下文取能力,不透传 deps。

import type { AccountSafe } from "@folio/db";
import { Effect, Stream } from "effect";
import { syncAccountEffect } from "./account";
import type { SyncDepError } from "./errors";
import { layerFromDeps } from "./services";
import { syncAllUsersEffect, syncUserEffect, syncUserStreamEffect } from "./sweep";
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
    syncAccountEffect(userId, account, rawCreds).pipe(Effect.provide(layerFromDeps(deps))),
  );

export const syncUser = (deps: SyncDeps, userId: string): Promise<SyncResult> =>
  Effect.runPromise(syncUserEffect(userId).pipe(Effect.provide(layerFromDeps(deps))));

// 逐账户产出的流,给要边跑边显示进度的调用方(主页「立即同步」)。
// 先完成先报,不保序 —— 按 accountId 认,别按下标。
export const syncUserStream = (
  deps: SyncDeps,
  userId: string,
): Stream.Stream<AccountSyncResult, SyncDepError> =>
  syncUserStreamEffect(userId).pipe(Stream.provideLayer(layerFromDeps(deps)));

export const syncAllUsers = (deps: SyncDeps, userIds: string[]): Promise<SweepResult> =>
  Effect.runPromise(syncAllUsersEffect(userIds).pipe(Effect.provide(layerFromDeps(deps))));
