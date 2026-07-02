// @folio/db —— 暴露门面 createDb(env)(带 userId 的包装操作,见 db.ts)+ 类型。
// 绝不导出 getDb / drizzle 实例 / schema / query builder。
// 非 userId 作用域的全局 infra 独立导出(不进 createDb):
//   · createAuthAdapter —— better-auth Drizzle adapter
//   · createTokenStore —— 全局代币参考缓存(无 userId,按 source 分桶)

export { createAuthAdapter } from "./auth"; // 不泄露 db 实例/schema
export type { DbEnv } from "./client";
export { createDb, type Db } from "./db";
export type {
  AccountRawCreds,
  CreateAccountInput,
  CreateGroupInput,
  ManualActivity,
  ManualActivityInput,
  ManualActivityKind,
  Membership,
  SnapshotBalanceInput,
  SnapshotTotal,
  SnapshotWithBalances,
  WriteSnapshotInput,
} from "./queries";
export type {
  Account,
  AccountGroup,
  AccountSafe,
  Group,
  Snapshot,
  SnapshotBalance,
} from "./schema-types";
export { createTokenStore, type TokenStoreOpts } from "./token-store"; // 全局代币参考缓存(无 userId,按 source 分桶)
