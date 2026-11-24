// DbClient and CurrentUser are exported as types only: exporting the Tags would let outside code bypass the wrappers or run as any user. Assembly uses the provide* combinators.
export { type DbClient, provideDbClient } from "./client";
export { createAuthAdapter, type DbEnv } from "./connect";
export { type CurrentUser, provideCurrentUser } from "./current-user";
// Tickets: `Database` is per-user; `GlobalDatabase` holds ops with no owner; `DatabaseForOracle` is for @folio/oracle only and deliberately not on `Database`, so no handler can edit token rows directly.
export {
  type CacheStore,
  Database,
  DatabaseForOracle,
  type DbRequest,
  databaseTickets,
  GlobalDatabase,
  type GlobalRefIndexStore,
  type TokenPriceStore,
  type TokenStore,
} from "./database";
export type {
  AccountRawCreds,
  AccountWithPortfolio,
  CreateAccountInput,
} from "./domains/accounts";
export type { CacheEntry, CacheWrite } from "./domains/cache";
export type { RefIndexDiffCounts } from "./domains/global-ref-index";
export type {
  ManualActivity,
  ManualActivityInput,
  ManualActivityKind,
  ManualActivityPatch,
  ManualBatchPlan,
  ManualHolding,
} from "./domains/manual";
export type { PortfolioMembership } from "./domains/portfolios";
export type { UserSettingsView } from "./domains/settings";
export type {
  BalanceRawRow,
  SnapshotBalanceInput,
  SnapshotBalanceView,
  SnapshotRawRow,
  SnapshotRawRows,
  SnapshotTotal,
  SnapshotWithBalances,
  WriteSnapshotInput,
} from "./domains/snapshots";
export type {
  OpenSyncRoundResult,
  SyncRoundAccount,
  SyncRoundAccountStatus,
  SyncRoundRecord,
  SyncRoundTrigger,
} from "./domains/sync-rounds";
export type { TabPinInput } from "./domains/tab-pins";
export type { AccountTagLink, CreateTagInput } from "./domains/tags";
export type { ExportToken, ImportTokenInput } from "./domains/transfer";
export { InvalidInput, NotFound } from "./errors";
// Second connection kind: Node cron jobs have no D1 binding, so they pass in a SQL transport that becomes the same `DbClient`.
export {
  provideRemoteDbClient,
  type RemoteMethod,
  type RemoteSql,
  type RemoteStatement,
} from "./remote";
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
