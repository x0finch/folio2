// @folio/sync —— 同步编排。取账户 → 取余额(重试/超时)→ 认币 → 重估 → 写快照。
//
// **出口就是内核**(ADR 0035 这一站走完,#403 片 3):调用方自己提供 `SyncServices`,本包不再有
// Promise 壳、不再 `runPromise`。以前那层 `layerFromDeps(deps)` 把 Promise 形状的 `SyncDeps`
// 翻成服务 —— 它存在的理由是「调用方还没在 Effect 里」,而那个理由没了。
//
// **内核不加后缀。** Effect 生态里 `*Effect` 有确定含义 ——「回调收 Effect 的那个变体」
// (`runFold`/`runFoldEffect`、`filterMap`/`filterMapEffect`,三十多对),从不表示「依赖还没接上」;
// 那是类型第三位的事,不进名字。同名冲突用**命名空间导入**化掉,这也正是 Effect 自己的写法
// (`Stream.runFold` / `Effect.gen`)。
//
// **「所有用户」那一层不在这个包里**:服务是按用户装配的(见 services.ts),一份服务服务不了多个
// 用户,所以「逐用户装配 + 累加」属于做装配的那一方(`apps/web` 的 `syncAllUsers`)。本包只交出
// `Sweep.userTally`(一个用户的小计)与 `Sweep.sumTallies`(小计怎么加)。
//
// 内部组织:`types` 公开类型 / `services` 能力与 Layer / `retry` 退避策略 /
// `account` 单账户 / `sweep` 单用户。业务代码从上下文取能力,不透传 deps。

// 编排内核。
export * as Account from "./account";
// 平台推导:写快照时用;app 侧采集 provider 元信息时也用同一条,免得两处口径分叉。
export { SYNC_CONCURRENCY } from "./constants";
export { depError, SyncDepError, type SyncDepStep } from "./errors";
export { platformOf } from "./platform";
// 能力的 Tag 与集合类型 + 日志层:调用方要自己建这一层,就得拿得到它们。
export {
  AccountStore,
  BalanceSource,
  SnapshotStore,
  type SyncServices,
  TokenOracle,
} from "./services";
export * as Sweep from "./sweep";
export type {
  AccountSyncResult,
  FetchOutcome,
  SweepResult,
  SyncLogger,
  SyncResult,
  SyncSkipReason,
} from "./types";
