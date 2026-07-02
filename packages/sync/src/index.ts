// @folio/sync —— 同步编排:取账户 → 注入的 fetchBalances(解密/校验/取数在 @folio/balances 内)→ 重估 → 写快照。
// 数据访问与取余额均为注入式依赖(见 orchestrator.ts 的 SyncDeps);本包不连 D1、不碰 provider/creds 原语。

export type {
  AccountSyncResult,
  SweepResult,
  SyncDeps,
  SyncLogger,
  SyncResult,
} from "./orchestrator";
export { syncAccount, syncAllUsers, syncUser } from "./orchestrator";
