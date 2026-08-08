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
import { layerFromDeps, type SyncServices } from "./services";
import * as Sweep from "./sweep";
import type { AccountSyncResult, SweepResult, SyncDeps, SyncResult } from "./types";

// 平台推导:写快照时用;app 侧采集 provider 元信息时也用同一条,免得两处口径分叉。
export { SYNC_CONCURRENCY } from "./constants";
export { SyncDepError, type SyncDepStep } from "./errors";
export { platformOf } from "./platform";
export type {
  AccountSyncResult,
  FetchOutcome,
  SweepResult,
  SyncDeps,
  SyncLogger,
  SyncResult,
} from "./types";

// **一个用户 = 一次装配**(#403 片 1)。`layerFromDeps` 现在收 userId,所以每条出口都在这里
// 按用户把服务建起来 —— 包内业务代码从此看不见 userId(日志上下文那一处除外)。
const forUser = <A, E>(
  deps: SyncDeps,
  userId: string,
  effect: Effect.Effect<A, E, SyncServices>,
): Effect.Effect<A, E> => effect.pipe(Effect.provide(layerFromDeps(deps, userId)));

export const syncAccount = (
  deps: SyncDeps,
  userId: string,
  account: AccountSafe,
  rawCreds: string | null,
): Promise<AccountSyncResult> =>
  Effect.runPromise(forUser(deps, userId, Account.syncAccount(userId, account, rawCreds)));

export const syncUser = (deps: SyncDeps, userId: string): Promise<SyncResult> =>
  Effect.runPromise(forUser(deps, userId, Sweep.syncUser(userId)));

// 逐账户产出的流,给要边跑边显示进度的调用方(主页「立即同步」)。
// 先完成先报,不保序 —— 按 accountId 认,别按下标。
export const syncUserStream = (
  deps: SyncDeps,
  userId: string,
): Stream.Stream<AccountSyncResult, SyncDepError> =>
  Sweep.syncUserStream(userId).pipe(Stream.provideLayer(layerFromDeps(deps, userId)));

// 全量 sweep:**逐用户各装一次**,再把小计加起来。
//
// 循环在这一层而不是在 `sweep.ts` 里,是服务变成 per-user 之后的必然:一份服务服务不了多个用户
// (见 services.ts 那段判据)。包只交出「一个用户的小计」与「小计怎么加」,谁做装配谁跑循环 ——
// 片 3 之后这个循环会搬到 `apps/web`,与那边已有的 `warmAllUsers` 形状一致。
//
// **串行不是遗漏,是有意的**:cron 一次调用有 CPU / subrequest 预算,几十个用户并发会顶穿
// (见 apps/web server.ts 里两个 trigger 拆开的理由)。用 `Effect.forEach` 的默认串行语义,
// **别顺手加 concurrency** —— tests/sweep.test.ts 有一条专门钉这个。
export const syncAllUsers = (deps: SyncDeps, userIds: string[]): Promise<SweepResult> =>
  Effect.runPromise(
    Effect.forEach(userIds, (userId) => forUser(deps, userId, Sweep.userTally(userId))).pipe(
      Effect.map((tallies) => Sweep.sumTallies(userIds.length, tallies)),
    ),
  );
