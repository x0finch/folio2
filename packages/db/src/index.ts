// @folio/db 的出口。包外只能看见这里写出来的东西 —— 绝不出 getDb / drizzle 句柄 / schema /
// query builder(原则 #6)。
//
// 包内两半,各有自己的薄壳:
//   · queries/ —— 接口 db 自己定的那半,统一走门面 `createDb(env)`(见 queries/facade.ts)
//   · stores/  —— 接口 `@folio/oracle-basic` 定的那半(四个参考层端口),出口是 Layer
// 非 userId 作用域的 better-auth adapter 不进门面,单独出(它和 `getDb` 一起住 connect.ts)。

export { createAuthAdapter, type DbEnv } from "./connect"; // adapter 不泄露 db 句柄/schema
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
// per-user 的领域服务(ADR 0037)。**Tag + layer 都出** —— 与 `Database` 不同:那个的 `query`
// 回调参数就是 drizzle 句柄,出包等于把包装层作废;这些服务的方法本来就是包装过的 op,
// 出包正是让 app 能把一次请求的全部数据访问装进同一个 context(#394 T4 起)。
export {
  AccountStore,
  accountStoreLayer,
  listUserIdsWithAccounts,
} from "./queries/accounts";
export { TransferStore, transferStoreLayer } from "./queries/export-import";
export { createDb, type Db } from "./queries/facade";
export { ManualStore, manualStoreLayer } from "./queries/manual-activity";
export { PortfolioStore, portfolioStoreLayer } from "./queries/portfolios";
export { SettingsStore, settingsStoreLayer } from "./queries/settings";
export { SnapshotStore, snapshotStoreLayer } from "./queries/snapshots";
export { TabPinStore, tabPinStoreLayer } from "./queries/tab-pins";
export { TagStore, tagStoreLayer } from "./queries/tags";
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
