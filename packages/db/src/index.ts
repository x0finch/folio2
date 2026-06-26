// @folio/db —— 只暴露带 userId 的包装操作 + 类型。
// 绝不导出:getDb / drizzle 实例 / schema 对象 / 任何 query builder。
export {
  createAccount,
  listAccountsByUser,
  getAccountById,
  getEncryptedCredentials,
  deleteAccount,
  createGroup,
  listGroupsByUser,
  deleteGroup,
  addAccountToGroup,
  removeAccountFromGroup,
  listGroupsByAccount,
  listAccountsByGroup,
  writeSnapshot,
  listSnapshotsByAccount,
  getLatestSnapshotByUser,
} from "./queries";

export type {
  CreateAccountInput,
  CreateGroupInput,
  WriteSnapshotInput,
  SnapshotBalanceInput,
  SnapshotWithBalances,
} from "./queries";

export type { DbEnv } from "./client";
export type {
  Account,
  AccountSafe,
  Group,
  AccountGroup,
  Snapshot,
  SnapshotBalance,
} from "./schema-types";
