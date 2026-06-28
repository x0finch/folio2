// @folio/db —— 只暴露带 userId 的包装操作 + 类型。
// 绝不导出:getDb / drizzle 实例 / schema 对象 / 任何 query builder。

export { createAuthAdapter } from "./auth"; // better-auth Drizzle adapter(不泄露 db 实例/schema)
export type { DbEnv } from "./client";

export type {
  CreateAccountInput,
  CreateGroupInput,
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
  getEncryptedCredentials,
  getLatestSnapshotByUser,
  listAccountsByGroup,
  listAccountsByUser,
  listAccountsNeedingCredentials,
  listBalancesForSnapshots,
  listGroupsByAccount,
  listGroupsByUser,
  listMembershipsByUser,
  listSnapshotsByAccount,
  listSnapshotsPageByUser,
  listSnapshotTotalsByUser,
  listUserIdsWithAccounts,
  removeAccountFromGroup,
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
