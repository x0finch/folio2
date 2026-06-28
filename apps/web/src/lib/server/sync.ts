import { env } from "cloudflare:workers";
import { getRawCreds, listAccountsByUser, writeSnapshot } from "@folio/db";
import { type SyncDeps, syncUser } from "@folio/sync";
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";

// 把 @folio/db 的包装函数绑好 env 后装进编排器的注入式依赖(数据访问仍只经 db 包);
// 密钥与全局 key 从 env 取。triggerSync(手动)与 cron(scheduled,见 src/server.ts)共用,
// 故抽成接收 bindings 的工厂(消除两处重复的 env→deps + globalKeys 装配)。
export function buildSyncDeps(bindings: Cloudflare.Env): SyncDeps {
  return {
    listAccounts: (userId) => listAccountsByUser(bindings, userId),
    getRawCreds: (userId, accountId) => getRawCreds(bindings, userId, accountId),
    writeSnapshot: (userId, accountId, input) => writeSnapshot(bindings, userId, accountId, input),
    secretsKey: bindings.SECRETS_KEY,
    // provider 全局 key:各 provider 按 usesGlobalKeys 只拿到自己声明的(见 @folio/sync scopeGlobalKeys)。
    globalKeys: {
      ZERION_API_KEY: bindings.ZERION_API_KEY,
      COINSTATS_API_KEY: bindings.COINSTATS_API_KEY,
    },
  };
}

// 手动触发同步:遍历该用户全部账户,逐账户隔离写快照。返回每账户 ok/fail,不含任何密钥/明文凭据。
export const triggerSync = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(({ context }) => syncUser(buildSyncDeps(env), context.userId));
