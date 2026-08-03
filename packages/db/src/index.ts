// @folio/db —— 暴露门面 createDb(env)(带 userId 的包装操作,见 db.ts)+ 类型。
// 绝不导出 getDb / drizzle 实例 / schema / query builder。
// 非 userId 作用域的全局 infra 独立导出(不进 createDb):
//   · createAuthAdapter —— better-auth Drizzle adapter

export { createAuthAdapter } from "./auth"; // 不泄露 db 实例/schema
export type { DbEnv } from "./client";
export { createDb, type Db } from "./db";
// 新参考层的 store(ADR 0021/0022/0023,#199)。#202 起是唯一一套 —— 旧的全局 token-store /
// price-history-store 已删。名字带作用域(user / global):旧 store 只说「什么表」不说「谁的数据」,
// 那正是这次改掉的事。
export { createGlobalTokenRefIndexStore } from "./global-token-ref-index-store";
export type {
  AccountRawCreds,
  CreateAccountInput,
  ExportToken,
  ImportTokenInput,
  ManualActivity,
  ManualActivityInput,
  ManualActivityKind,
  ManualActivityPatch,
  ManualBatchPlan,
  ManualHolding,
  SnapshotBalanceHistoryRow,
  SnapshotBalanceInput,
  SnapshotBalanceView,
  SnapshotTotal,
  SnapshotWithBalances,
  UserSettingsView,
  WriteSnapshotInput,
} from "./queries";
export type {
  Account,
  AccountSafe,
  Snapshot,
  SnapshotBalance,
  UserSettings,
  ValuationMode,
} from "./schema-types";
export { createUserCacheStore, type UserCacheStoreOpts } from "./user-cache-store";
export {
  createUserTokenPriceStore,
  type UserTokenPriceStoreOpts,
} from "./user-token-price-store";
export { createUserTokenStore, type UserTokenStoreOpts } from "./user-token-store";
