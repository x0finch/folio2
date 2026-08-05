// @folio/sync —— 同步编排:取账户 → 注入的 fetchBalances(解密/校验/取数在 provider(@folio/connectors)内)→ 重估 → 写快照。
// 数据访问与取余额均为注入式依赖(见 orchestrator.ts 的 SyncDeps);本包不连 D1、不碰 provider/creds 原语。

export { FetchBalancesError, SyncDepError, type SyncDepStep } from "./errors";
export type {
  AccountSyncResult,
  FetchOutcome,
  SweepResult,
  SyncDeps,
  SyncLogger,
  SyncResult,
} from "./orchestrator";
// Promise 壳 + Effect 内核并存(Effect 迁移第 1 步,ADR 0035)。壳是当前的正式出口(app 侧零改动);
// 内核给需要 Effect 上下文的场合用 —— 眼下只有时序测试(假时钟挂不到壳上),下一步出口改成 Effect
// 时内核转正、壳删掉。
export {
  syncAccount,
  syncAccountEffect,
  syncAllUsers,
  syncAllUsersEffect,
  syncUser,
  syncUserEffect,
} from "./orchestrator";
// 平台推导:写快照时用;app 侧采集 provider 元信息时也用同一条,免得两处口径分叉。
export { platformOf } from "./platform";
