// @folio/db —— 只暴露带 userId 的包装操作 + 类型。
// 绝不导出:getDb / drizzle 实例 / schema 对象 / 任何 query builder。

export { createAuthAdapter } from "./auth"; // better-auth Drizzle adapter(不泄露 db 实例/schema)
export type { DbEnv } from "./client";
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
export {
  addAccountToGroup,
  createAccount,
  createGroup,
  deleteAccount,
  deleteGroup,
  getAccountById,
  getLatestSnapshotByUser,
  getRawCreds,
  listAccountsByGroup,
  listAccountsByUser,
  listBalancesForSnapshots,
  listGroupsByAccount,
  listGroupsByUser,
  listManualActivityByAccount,
  listMembershipsByUser,
  listRawCredsByUser,
  listSnapshotsByAccount,
  listSnapshotsPageByUser,
  listSnapshotTotalsByUser,
  listUserIdsWithAccounts,
  recordManualActivity,
  removeAccountFromGroup,
  removeManualActivity,
  setAccountCredentials,
  writeSnapshot,
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
