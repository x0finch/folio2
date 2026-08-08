import { type Context, Effect, Layer } from "effect";
import type { DbEnv } from "../connect";
import type { ValuationMode } from "../schema/types";
import { type Database, databaseLayer } from "../stores/service";
import * as q from ".";

// `queries/` 这半的对外面:createDb(env) 绑定 env,返回一个方法对象,调用方不再逐次穿 env。
// 仍恪守原则 #6:只暴露包装 ops,绝不外泄 getDb / drizzle 实例 / schema。
// createAuthAdapter 与参考层那四个 store 是非 userId 作用域的东西(better-auth / 参考数据),
// 不进本门面 —— 前者在 ../connect.ts,后者在 ../stores/。
//
// —— **过渡期的形状**(#394,ADR 0037)——
//
// 领域正在逐个从「收 env + userId 的平铺函数」变成「per-user 的 Effect 服务」。**门面的签名一个
// 字都不变** —— `db.listAccountsByUser(userId)` 照旧 —— 所以 app 那 92 处调用点在整个迁移期间
// 不用动一行,逐片搬走,最后(#394 的 T8)连这层门面一起删。
//
// 于是这里同时有两种转接:
//   · 已迁的领域走 `viaStore`:建 per-user layer + `runPromise`
//   · 未迁的领域照旧 `b(q.fn)`:柯里掉 env
//
// 代价说清楚:`viaStore` 每次调用各装一次 layer、各跑一次 `runPromise`,方向上跟这次要达成的
// 「一次请求一次装配」相反。很轻(`drizzle(env.DB)` + 两个闭包,见 connect.ts),且只活到 T8。
const bindEnv =
  (env: DbEnv) =>
  <A extends unknown[], R>(fn: (env: DbEnv, ...args: A) => R) =>
  (...args: A): R =>
    fn(env, ...args);

// 已迁领域的转接:userId → per-user layer → 跑一个方法。
const viaStore =
  <I, S>(
    env: DbEnv,
    tag: Context.Tag<I, S>,
    layerOf: (userId: string) => Layer.Layer<I, never, Database>,
  ) =>
  <A>(userId: string, f: (store: S) => Effect.Effect<A>): Promise<A> =>
    Effect.runPromise(
      Effect.flatMap(tag, f).pipe(
        Effect.provide(Layer.provide(layerOf(userId), databaseLayer(env))),
      ),
    );

export function createDb(env: DbEnv) {
  const b = bindEnv(env);
  const account = viaStore(env, q.AccountStore, q.accountStoreLayer);
  const portfolio = viaStore(env, q.PortfolioStore, q.portfolioStoreLayer);
  const settings = viaStore(env, q.SettingsStore, q.settingsStoreLayer);
  const snapshot = viaStore(env, q.SnapshotStore, q.snapshotStoreLayer);
  const manual = viaStore(env, q.ManualStore, q.manualStoreLayer);
  return {
    // —— accounts(已迁,#394 T1)——
    createAccount: (userId: string, input: q.CreateAccountInput) =>
      account(userId, (s) => s.create(input)),
    listAccountsByUser: (userId: string) => account(userId, (s) => s.list()),
    getAccountById: (userId: string, id: string) => account(userId, (s) => s.getById(id)),
    setAccountCredentials: (userId: string, id: string, creds: string) =>
      account(userId, (s) => s.setCredentials(id, creds)),
    renameAccount: (userId: string, id: string, label: string) =>
      account(userId, (s) => s.rename(id, label)),
    setArchived: (userId: string, id: string, archived: boolean) =>
      account(userId, (s) => s.setArchived(id, archived)),
    deleteAccount: (userId: string, id: string) => account(userId, (s) => s.remove(id)),
    getRawCreds: (userId: string, id: string) => account(userId, (s) => s.getRawCreds(id)),
    listRawCredsByUser: (userId: string) => account(userId, (s) => s.listRawCreds()),
    // 系统级枚举(无 userId 入参,原则 #6 受控例外)——不是服务,直接 provide db 层跑。
    listUserIdsWithAccounts: (): Promise<string[]> =>
      Effect.runPromise(q.listUserIdsWithAccounts.pipe(Effect.provide(databaseLayer(env)))),
    // —— portfolios(已迁,#394 T1;ADR 0033)——
    ensureDefaultPortfolio: (userId: string) => portfolio(userId, (s) => s.ensureDefault()),
    listPortfoliosByUser: (userId: string) => portfolio(userId, (s) => s.list()),
    listPortfolioMembershipsByUser: (userId: string) =>
      portfolio(userId, (s) => s.listMemberships()),
    createPortfolio: (userId: string, input: { name: string; sortOrder?: number }) =>
      portfolio(userId, (s) => s.create(input)),
    assignAccountToPortfolio: (userId: string, accountId: string, portfolioId: string) =>
      portfolio(userId, (s) => s.assignAccount(accountId, portfolioId)),
    renamePortfolio: (userId: string, portfolioId: string, name: string) =>
      portfolio(userId, (s) => s.rename(portfolioId, name)),
    setDefaultPortfolio: (userId: string, portfolioId: string) =>
      portfolio(userId, (s) => s.setDefault(portfolioId)),
    deletePortfolio: (userId: string, portfolioId: string) =>
      portfolio(userId, (s) => s.remove(portfolioId)),
    // —— user settings(已迁,#394 T1;Phase 3)——
    getUserSettings: (userId: string) => settings(userId, (s) => s.get()),
    updateUserSettings: (userId: string, patch: { valuationMode?: ValuationMode }) =>
      settings(userId, (s) => s.update(patch)),
    // —— Tag(Portfolio 内软标签,ADR 0034)—— 待迁(T3)
    createTag: b(q.createTag),
    listTagsByUser: b(q.listTagsByUser),
    listTagsByPortfolio: b(q.listTagsByPortfolio),
    renameTag: b(q.renameTag),
    deleteTag: b(q.deleteTag),
    attachTag: b(q.attachTag),
    detachTag: b(q.detachTag),
    listAccountTagsByUser: b(q.listAccountTagsByUser),
    // —— 自定义 Tab pin(ADR 0034)—— 待迁(T3)
    createTabPin: b(q.createTabPin),
    listTabPinsByUser: b(q.listTabPinsByUser),
    updateTabPinTarget: b(q.updateTabPinTarget),
    reorderTabPins: b(q.reorderTabPins),
    deleteTabPin: b(q.deleteTabPin),
    // —— snapshots(已迁,#394 T2)——
    writeSnapshot: (userId: string, accountId: string, input: q.WriteSnapshotInput) =>
      snapshot(userId, (s) => s.write(accountId, input)),
    listSnapshotsByAccount: (userId: string, accountId: string) =>
      snapshot(userId, (s) => s.listByAccount(accountId)),
    listSnapshotTotalsByUser: (userId: string) => snapshot(userId, (s) => s.listTotals()),
    listSnapshotBalancesByUser: (userId: string, since?: number) =>
      snapshot(userId, (s) => s.listBalanceHistory(since)),
    getLatestSnapshotByUser: (userId: string) => snapshot(userId, (s) => s.latest()),
    listSnapshotsPageByUser: (userId: string, limit: number, offset: number) =>
      snapshot(userId, (s) => s.listPage(limit, offset)),
    listBalancesForSnapshots: (userId: string, snapshotIds: string[]) =>
      snapshot(userId, (s) => s.balancesFor(snapshotIds)),
    // —— manual 持仓 + activity(已迁,#394 T2;ADR 0017,#203 起持仓就是 tokens 行)——
    listManualHoldingsByAccount: (userId: string, accountId: string, namer: string) =>
      manual(userId, (s) => s.listHoldings(accountId, namer)),
    setManualHoldingDef: (userId: string, tokenId: string, input: { symbol?: string }) =>
      manual(userId, (s) => s.setHoldingDef(tokenId, input)),
    detachManualHolding: (userId: string, accountId: string, tokenId: string) =>
      manual(userId, (s) => s.detachHolding(accountId, tokenId)),
    recordManualActivity: (
      userId: string,
      accountId: string,
      tokenId: string,
      input: q.ManualActivityInput,
    ) => manual(userId, (s) => s.recordActivity(accountId, tokenId, input)),
    listManualActivityByAccount: (userId: string, accountId: string) =>
      manual(userId, (s) => s.listActivityByAccount(accountId)),
    listManualActivityByUser: (userId: string) => manual(userId, (s) => s.listAllActivity()),
    listManualActivityByToken: (userId: string, accountId: string, tokenId: string) =>
      manual(userId, (s) => s.listActivityByToken(accountId, tokenId)),
    removeManualActivity: (userId: string, accountId: string, id: string) =>
      manual(userId, (s) => s.removeActivity(accountId, id)),
    getManualActivityOwner: (userId: string, activityId: string) =>
      manual(userId, (s) => s.activityOwner(activityId)),
    updateManualActivity: (userId: string, activityId: string, patch: q.ManualActivityPatch) =>
      manual(userId, (s) => s.updateActivity(activityId, patch)),
    commitManualBatch: (userId: string, plan: q.ManualBatchPlan) =>
      manual(userId, (s) => s.commitBatch(plan)),
    // —— 导出/导入 v3(#204)—— 待迁(T3)
    listTokensForExport: b(q.listTokensForExport),
    importToken: b(q.importToken),
    importAccount: b(q.importAccount),
    importSnapshot: b(q.importSnapshot),
    importManualActivity: b(q.importManualActivity),
  };
}

export type Db = ReturnType<typeof createDb>;
