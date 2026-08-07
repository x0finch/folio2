// @folio/db —— 暴露门面 createDb(env)(带 userId 的包装操作,见 db.ts)+ 类型。
// 绝不导出 getDb / drizzle 实例 / schema / query builder。
// 非 userId 作用域的全局 infra 独立导出(不进 createDb):
//   · createAuthAdapter —— better-auth Drizzle adapter

export { createAuthAdapter } from "./auth"; // 不泄露 db 实例/schema
export type { DbEnv } from "./client";
// 新参考层的 store(ADR 0021/0022/0023,#199)。#202 起是唯一一套。名字带作用域
// (user / global):旧 store 只说「什么表」不说「谁的数据」,那正是当初改掉的事。
//
// **它们出口是 Layer,不是工厂**(#362 第 5 站):参考层的端口是 Effect 服务,所以「怎么变成
// 那个端口」归实现方,装配点只挑「哪个用户」。四个 layer 共用一个 `Database`(D1 的服务面),
// 而 `env` 只在 `databaseLayer(env)` 那一处被读。
// **只出 layer,不出 Tag 的值**:`Database.query((db) => …)` 的回调参数就是 drizzle 句柄,
// Tag 一旦出包,包外 `yield* Database` 就能绕过全部包装层拼任意查询 —— 那正是原则 #6 禁的事。
// 装配点(`Layer.provide(storeLayer, databaseLayer(env))`)不需要 Tag 的值,类型位置够用。
export type { Database } from "./database";
export { databaseLayer } from "./database";
export { createDb, type Db } from "./db";
export { globalTokenRefIndexStoreLayer } from "./global-token-ref-index-store";
export type {
  AccountRawCreds,
  AccountTagLink,
  CreateAccountInput,
  CreateTagInput,
  ExportToken,
  ImportTokenInput,
  ManualActivity,
  ManualActivityInput,
  ManualActivityKind,
  ManualActivityPatch,
  ManualBatchPlan,
  ManualHolding,
  PortfolioMembership,
  SnapshotBalanceHistoryRow,
  SnapshotBalanceInput,
  SnapshotBalanceView,
  SnapshotTotal,
  SnapshotWithBalances,
  TabPinInput,
  UserSettingsView,
  WriteSnapshotInput,
} from "./queries";
export type {
  Account,
  AccountSafe,
  Snapshot,
  SnapshotBalance,
  TabPin,
  Tag,
  UserSettings,
  ValuationMode,
} from "./schema-types";
export { type UserCacheStoreOpts, userCacheStoreLayer } from "./user-cache-store";
export {
  type UserTokenPriceStoreOpts,
  userTokenPriceStoreLayer,
} from "./user-token-price-store";
export { type UserTokenStoreOpts, userTokenStoreLayer } from "./user-token-store";
