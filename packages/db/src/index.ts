// @folio/db 的出口。包外只能看见这里写出来的东西 —— 绝不出 getDb / drizzle 句柄 / schema /
// query builder(原则 #6)。
//
// 包内两半,各有自己的薄壳:
//   · queries/ —— 接口 db 自己定的那半,统一走门面 `createDb(env)`(见 db.ts)
//   · stores/  —— 接口 `@folio/oracle-basic` 定的那半(四个参考层端口),出口是 Layer
// 非 userId 作用域的全局 infra(better-auth adapter)不进门面,单独出。

export { createAuthAdapter } from "./auth-adapter"; // 不泄露 db 句柄/schema
export type { DbEnv } from "./connect";
export { createDb, type Db } from "./db";
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
} from "./schema/types";
// `Database` **只出类型不出值**:它的 `query((db) => …)` 回调参数就是 drizzle 句柄,Tag 一旦
// 出包,包外 `yield* Database` 就能绕过全部包装层拼任意查询。装配点只需要 `databaseLayer`。
export {
  type Database,
  databaseLayer,
  globalTokenRefIndexStoreLayer,
  type UserCacheStoreOpts,
  type UserTokenPriceStoreOpts,
  type UserTokenStoreOpts,
  userCacheStoreLayer,
  userTokenPriceStoreLayer,
  userTokenStoreLayer,
} from "./stores";
