// @folio/sync —— 同步编排:取账户 → 解密凭据 → 按 type 取 provider → fetchBalances → 写快照。
// 数据层注入式依赖(见 orchestrator.ts);provider 装配见 registry.ts(方案 A 摊平)。

export type {
  AccountSyncResult,
  SweepResult,
  SyncDeps,
  SyncLogger,
  SyncResult,
} from "./orchestrator";
export {
  runAccountSync,
  scopeGlobalKeys,
  syncAccount,
  syncAllUsers,
  syncUser,
} from "./orchestrator";
