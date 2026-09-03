// @folio/db 的出口。包外只能看见这里写出来的东西 —— 绝不出 getDb / drizzle 句柄 / schema /
// query builder(原则 #6)。
//
// 包内按**「这份接口是谁定的」**分两半,各有自己的薄壳(#504 T4):
//   · `domains/`      —— 一域一文件(多数是 per-user 服务,ADR 0037;`global-ref-index.ts`
//                        与 accounts 里那个 `makeGlobalAccountStore` 没有「谁的」这回事,
//                        归 `GlobalDatabase`)
//
// **`oracle-ports/` 那个目录没了**:参考层那三片(代币行 / 价格行 / 缓存)不再是「别人定接口、
// 这里顶上去实现」—— 它们和别的领域一样住 `domains/`,契约就是实现本身。倒置换不来第二个实现
// (唯一的第二实现是 oracle 测试里的内存假货),只换来两份会各自漂移的 doc。
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
// **对外的三张门票**(判据与理由都在 `database.ts`):
//   · `Database`          per-user,handler 拿的那张 —— 八个领域 + 那片 KV 缓存
//   · `GlobalDatabase`    没有「谁的」这回事的那些 op(全局映射表 + cron 扫用户)
//   · `DatabaseForOracle` 只给 `@folio/oracle`:代币行 / 价格行 / 缓存。**故意不在第一张上** ——
//                         挂上去等于给任何 handler 一条绕过参考层直接改代币行的路
export { Database, DatabaseForOracle, GlobalDatabase } from "./database";
// 领域的类型**按文件逐个转出**(#504 T13)。以前它们走 `domains/index.ts` 那个桶,而领域服务
// 反倒逐文件转 —— 同一个目录两套写法,「这个名字是哪个领域的」还得进桶里再找一次。
export type { AccountRawCreds, CreateAccountInput } from "./domains/accounts";
// 参考层那半的契约类型。**接口不再由 `@folio/oracle-basic` 定、db 顶上去实现** —— 它们就是
// db 里那几份实现推导出来的类型,出包是因为 oracle 的几片把 store 当参数往下传,要个名字。
export type { CacheEntry, CacheStore, CacheWrite } from "./domains/cache";
// 全局映射表的契约(从实现推导)。`@folio/oracle` 的 mint 要它 —— 那一片把 store 当参数传。
export type { GlobalRefIndexStore, RefIndexDiffCounts } from "./domains/global-ref-index";
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
  SnapshotBalanceHistoryRow,
  SnapshotBalanceInput,
  SnapshotBalanceView,
  SnapshotTotal,
  SnapshotWithBalances,
  WriteSnapshotInput,
} from "./domains/snapshots";
// 同步轮(ADR 0048)。**只出 app 真消费的名字**:轮记录及其字段类型、开轮的下场。
// 那几个 op 的入参对象类型不出包 —— 调用点都写字面量,导出只会让 knip 报孤儿。
export type {
  OpenSyncRoundResult,
  SyncRoundAccount,
  SyncRoundAccountStatus,
  SyncRoundRecord,
  SyncRoundTrigger,
} from "./domains/sync-rounds";
export type { TabPinInput } from "./domains/tab-pins";
export type { AccountTagLink, CreateTagInput } from "./domains/tags";
export type { TokenPriceStore } from "./domains/token-prices";
export type { TokenStore } from "./domains/tokens";
export type { ExportToken, ImportTokenInput } from "./domains/transfer";
// 这一层的类型化失败。`NotFound` 出现在带归属校验的那些 op 的 `E` 通道里(#504 T5),
// `InvalidInput` 出现在有域规则要查库才判得了的那些(#504 T6)—— 两个以前都是 defect。
export { InvalidInput, NotFound } from "./errors";
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
