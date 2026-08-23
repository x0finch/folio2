// @folio/db 的出口。包外只能看见这里写出来的东西 —— 绝不出 getDb / drizzle 句柄 / schema /
// query builder(原则 #6)。
//
// 包内两半,各有自己的薄壳:
//   · queries/ —— 接口 db 自己定的那半:**per-user 的 Effect 服务**(ADR 0037),Tag + layer 都出
//   · stores/  —— 接口 `@folio/oracle-basic` 定的那半(四个参考层端口),出口也是 Layer
// 非 userId 作用域的 better-auth adapter 单独出(它和 `getDb` 一起住 connect.ts)。
//
// **过渡期那层 `createDb(env)` 门面已经删掉**(#394 T8)。它在 T1 那阵存在是为了让 app 的九十多处
// 调用点能一片一片搬,而不是一个几千行的单体 PR;搬完最后一处的同一天它就该消失 —— 留着的话
// 「一次请求一次装配」旁边永远并排站着一条「每次调用各装一次」的路。

export { createAuthAdapter, type DbEnv } from "./connect"; // adapter 不泄露 db 句柄/schema
// **「这次请求是谁的」**(ADR 0044):装配点 provide 一次,包内每个 per-user 服务在建自己那一刻
// 读一次。没有默认值 —— 忘了 provide 是编译错误,不是静默按默认用户去查。
export { CurrentUser } from "./current-user";
// **对外的那一张门票**(#504 T1 起):聚合 `Database`,按领域挂包装好的 op。
// 现在只挂了 `tabPins` —— 其余八个领域还走下面那排各自的 Tag,按域一片片挂进来。
export { Database } from "./database";
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
// per-user 的领域服务(ADR 0037)。每个名字同时是**类型**、**Tag** 和**它的 layer**
// (`Effect.Service`:带 userId 的 `.Default(userId)` 就是 layer,#501)—— 与 `DbClient` 不同:
// 那个的 `query` 回调参数就是 drizzle 句柄,出包等于把包装层作废;这些服务的方法本来就是包装过
// 的 op,出包正是让 app 能把一次请求的全部数据访问装进同一个 context(#394 T4 起)。
//
// **这排 Tag 是过渡形状,只会变少**:某个领域挂进聚合 `Database` 之后,它的 Tag 就没有消费者了,
// 同片删除(tab-pins 已经这样退场)。
export { AccountStore, listUserIdsWithAccounts } from "./queries/accounts";
export { TransferStore } from "./queries/export-import";
export { ManualStore } from "./queries/manual-activity";
export { PortfolioStore } from "./queries/portfolios";
export { SettingsStore } from "./queries/settings";
export { SnapshotStore } from "./queries/snapshots";
export { TagStore } from "./queries/tags";
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
// `DbClient` **只出类型不出值**:它的 `query((db) => …)` 回调参数就是 drizzle 句柄,Tag 一旦
// 出包,包外 `yield* DbClient` 就能绕过全部包装层拼任意查询。装配点只需要 `dbClientLayer`。
export {
  type DbClient,
  dbClientLayer,
  globalTokenRefIndexStoreLayer,
  type UserTokenPriceStoreOpts,
  type UserTokenStoreOpts,
  userCacheStoreLayer,
  userTokenPriceStoreLayer,
  userTokenStoreLayer,
} from "./stores";
