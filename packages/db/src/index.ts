// @folio/db 的出口。包外只能看见这里写出来的东西 —— 绝不出 getDb / drizzle 句柄 / schema /
// query builder(原则 #6)。
//
// 包内按**「这份接口是谁定的」**分两半,各有自己的薄壳(#504 T4):
//   · `domains/`      —— db 自己定的那半:一域一文件的 per-user 服务(ADR 0037)
//   · `oracle-ports/` —— `@folio/oracle-basic` 定的那半(四个参考层端口),出口是 Layer
// 另有两件不属于任何一半,住在顶层:`client.ts`(那一处 drizzle 桥,**不出包**)与
// `current-user.ts`。非 userId 作用域的 better-auth adapter 单独出(它和 `getDb` 一起住 connect.ts)。
//
// **过渡期那层 `createDb(env)` 门面已经删掉**(#394 T8)。它在 T1 那阵存在是为了让 app 的九十多处
// 调用点能一片一片搬,而不是一个几千行的单体 PR;搬完最后一处的同一天它就该消失 —— 留着的话
// 「一次请求一次装配」旁边永远并排站着一条「每次调用各装一次」的路。

// `DbClient` **只出类型不出值**:它的 `query((db) => …)` 回调参数就是 drizzle 句柄,class 一旦
// 出包,包外 `yield* DbClient` 就能绕过全部包装层拼任意查询。装配点只需要 `dbClientLayer`
//(= `DbClient.Default`,在 `client.ts` 里起的别名,好让 class 本身留在包内)。
export { type DbClient, dbClientLayer } from "./client";
export { createAuthAdapter, type DbEnv } from "./connect"; // adapter 不泄露 db 句柄/schema
// **「这次请求是谁的」**(ADR 0044):装配点 provide 一次,包内每个 per-user 服务在建自己那一刻
// 读一次。没有默认值 —— 忘了 provide 是编译错误,不是静默按默认用户去查。
export { CurrentUser } from "./current-user";
// **对外的那一张门票**(#504 T1 起,T5 挂满):聚合 `Database`,八个领域全在里头,
// 按领域取用 —— `(yield* Database).accounts.list()`。
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
} from "./domains";
// per-user 的领域服务(ADR 0037)。每个名字同时是**类型**、**Tag** 和**它的 layer**
// (`Effect.Service`,#501)。**这些出值,`DbClient` 只出类型** —— 差别不在写法(两边都是
// `Effect.Service`),在**出去之后包外能干什么**:`DbClient.query` 的回调参数是 drizzle 句柄,
// 拿到它等于把包装层作废;而这些服务的方法本来就是包装过的 op,出包正是让 app 能把一次请求的
// 全部数据访问装进同一个 context(#394 T4 起)。
//
// **这排 Tag 是纯过渡形状,新代码别用**:八个领域已经全部挂进聚合 `Database`(#504 T5),
// 这里留着只为那批还没改写的 app 调用点;T7–T12 逐批换成 `yield* Database` 之后整排删除
// (tab-pins 已经这样退场 —— 它没有 class,只有一个 `makeTabPinStore`)。
export { AccountStore, listUserIdsWithAccounts } from "./domains/accounts";
export { ManualStore } from "./domains/manual";
export { PortfolioStore } from "./domains/portfolios";
export { SettingsStore } from "./domains/settings";
export { SnapshotStore } from "./domains/snapshots";
export { TagStore } from "./domains/tags";
export { TransferStore } from "./domains/transfer";
// 参考层那半:**一张 layer 给全四个端口**(#504 T5)。以前是四个 layer(两个还是带 opts 的
// 工厂)各自露出去,装配点逐个列举。`globalTokenRefIndexStoreLayer` 仍单独可拿 —— cron 刷全局
// 映射表没有 userId,不该为了它把 per-user 那三张也建出来。
export {
  globalTokenRefIndexStoreLayer,
  type OraclePortsOpts,
  oraclePortsLayer,
} from "./oracle-ports";
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
