import type { DbEnv } from "./client";
import * as q from "./queries";

// @folio/db 的对外门面:createDb(env) 绑定 env,返回一个方法对象,调用方不再逐次穿 env。
// 每个方法 = queries.ts 现有函数去掉首个 env 参数(userId 及其余入参、返回类型、归属校验语义全不变)。
// 仍恪守原则 #6:只暴露包装 ops,绝不外泄 getDb / drizzle 实例 / schema。
// bind() 把 (env, ...rest) 的函数柯里成 (...rest),类型经推断保留 —— 方法仍逐个显式列出,不做 Proxy/循环魔法。
// createTokenStore / createAuthAdapter 是非 userId 作用域的全局 infra(代币缓存 / better-auth),
// 不进本 facade,由 index 独立导出。
const bindEnv =
  (env: DbEnv) =>
  <A extends unknown[], R>(fn: (env: DbEnv, ...args: A) => R) =>
  (...args: A): R =>
    fn(env, ...args);

export function createDb(env: DbEnv) {
  const b = bindEnv(env);
  return {
    // —— accounts ——
    createAccount: b(q.createAccount),
    listAccountsByUser: b(q.listAccountsByUser),
    getAccountById: b(q.getAccountById),
    setAccountCredentials: b(q.setAccountCredentials),
    renameAccount: b(q.renameAccount),
    setArchived: b(q.setArchived),
    deleteAccount: b(q.deleteAccount),
    getRawCreds: b(q.getRawCreds),
    listRawCredsByUser: b(q.listRawCredsByUser),
    listUserIdsWithAccounts: b(q.listUserIdsWithAccounts), // 系统级枚举(无 userId 入参,原则 #6 受控例外)
    // —— groups ——
    createGroup: b(q.createGroup),
    listGroupsByUser: b(q.listGroupsByUser),
    deleteGroup: b(q.deleteGroup),
    addAccountToGroup: b(q.addAccountToGroup),
    removeAccountFromGroup: b(q.removeAccountFromGroup),
    listGroupsByAccount: b(q.listGroupsByAccount),
    listAccountsByGroup: b(q.listAccountsByGroup),
    listMembershipsByUser: b(q.listMembershipsByUser),
    // —— snapshots ——
    writeSnapshot: b(q.writeSnapshot),
    listSnapshotsByAccount: b(q.listSnapshotsByAccount),
    listSnapshotTotalsByUser: b(q.listSnapshotTotalsByUser),
    getLatestSnapshotByUser: b(q.getLatestSnapshotByUser),
    listSnapshotsPageByUser: b(q.listSnapshotsPageByUser),
    listBalancesForSnapshots: b(q.listBalancesForSnapshots),
    // —— manual activity ——
    recordManualActivity: b(q.recordManualActivity),
    listManualActivityByAccount: b(q.listManualActivityByAccount),
    removeManualActivity: b(q.removeManualActivity),
  };
}

export type Db = ReturnType<typeof createDb>;
