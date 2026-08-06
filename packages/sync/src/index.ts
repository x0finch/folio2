// @folio/sync —— 同步编排。取账户 → 取余额(重试/超时)→ 认币 → 重估 → 写快照。
//
// 出口(Effect 迁移中,ADR 0035):内部全是 Effect,这里把依赖接上再交给调用方。
//   · `syncAccount` / `syncUser` / `syncAllUsers` —— Promise,跑完给结果
//   · `syncUserStream` —— 流,逐账户产出,给要边跑边显示进度的调用方
// 公开面只留真有消费者的;包内测试直接 import `./account` / `./sweep` 自己 provide,不走这里。
//
// **内核不加后缀。** Effect 生态里 `*Effect` 是有确定含义的 —— 「回调收 Effect 的那个变体」
// (`runFold`/`runFoldEffect`、`filterMap`/`filterMapEffect`、`modifyDelay`/`modifyDelayEffect`,
// 三十多对),从不表示「依赖还没接上」;那是类型第三位的事,不进名字。所以内核就叫 `syncUser`,
// 壳也叫 `syncUser`,同名的那点冲突用**命名空间导入**化掉 —— 这也正是 Effect 自己的写法
// (`Stream.runFold` / `Effect.gen`)。下一步壳拆掉之后,`Sweep.syncUser` 直接就是出口。
//
// 内部组织:`types` 公开类型 / `services` 能力与 Layer / `retry` 退避策略 /
// `account` 单账户 / `sweep` 单用户与全量。业务代码从上下文取能力,不透传 deps。

import type { AccountSafe } from "@folio/db";
import { Effect, Stream } from "effect";
import * as Account from "./account";
import type { SyncDepError } from "./errors";
import { layerFromDeps } from "./services";
import * as Sweep from "./sweep";
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
    Account.syncAccount(userId, account, rawCreds).pipe(Effect.provide(layerFromDeps(deps))),
  );

export const syncUser = (deps: SyncDeps, userId: string): Promise<SyncResult> =>
  Effect.runPromise(Sweep.syncUser(userId).pipe(Effect.provide(layerFromDeps(deps))));

// 逐账户产出的流,给要边跑边显示进度的调用方(主页「立即同步」)。
// 先完成先报,不保序 —— 按 accountId 认,别按下标。
export const syncUserStream = (
  deps: SyncDeps,
  userId: string,
): Stream.Stream<AccountSyncResult, SyncDepError> =>
  Sweep.syncUserStream(userId).pipe(Stream.provideLayer(layerFromDeps(deps)));

export const syncAllUsers = (deps: SyncDeps, userIds: string[]): Promise<SweepResult> =>
  Effect.runPromise(Sweep.syncAllUsers(userIds).pipe(Effect.provide(layerFromDeps(deps))));
