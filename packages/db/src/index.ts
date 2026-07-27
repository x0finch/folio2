// @folio/db —— 暴露门面 createDb(env)(带 userId 的包装操作,见 db.ts)+ 类型。
// 绝不导出 getDb / drizzle 实例 / schema / query builder。
// 非 userId 作用域的全局 infra 独立导出(不进 createDb):
//   · createAuthAdapter —— better-auth Drizzle adapter
//   · createTokenStore —— 全局代币参考缓存(无 userId,按 source 分桶)

export { createAuthAdapter } from "./auth"; // 不泄露 db 实例/schema
export type { DbEnv } from "./client";
export { createDb, type Db } from "./db";
export { createFxStore } from "./fx-store"; // FX 汇率缓存(展示币种,全局无 userId)
// 新参考层的四个 store(ADR 0021/0022/0023,#199)。与上面那套并存到 #202。
// 名字带作用域(user / global)—— 旧 store 只说「什么表」,不说「谁的数据」,那正是这次要改的事。
export { createGlobalTokenRefIndexStore } from "./global-token-ref-index-store";
export { createPlatformStore } from "./platform-store"; // 平台元数据缓存(链 ∪ 交易所)
export { createTokenPriceHistoryStore } from "./price-history-store"; // 历史日价缓存(全局无 userId,#148)
export type {
  AccountRawCreds,
  CreateAccountInput,
  CreateGroupInput,
  ManualActivity,
  ManualActivityInput,
  ManualActivityKind,
  ManualActivityPatch,
  ManualBatchPlan,
  ManualToken,
  ManualTokenInput,
  Membership,
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
  AccountGroup,
  AccountSafe,
  Group,
  Snapshot,
  SnapshotBalance,
  UserSettings,
  ValuationMode,
} from "./schema-types";
export { createTokenStore, type TokenStoreOpts } from "./token-store"; // 全局代币参考缓存(无 userId,按 source 分桶)
export { createUserCacheStore, type UserCacheStoreOpts } from "./user-cache-store";
export {
  createUserTokenPriceStore,
  type UserTokenPriceStoreOpts,
} from "./user-token-price-store";
export { createUserTokenStore, type UserTokenStoreOpts } from "./user-token-store";
