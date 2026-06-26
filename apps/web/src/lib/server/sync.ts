import { env } from "cloudflare:workers";
import { getEncryptedCredentials, listAccountsByUser, writeSnapshot } from "@folio/db";
import { type SyncDeps, syncUser } from "@folio/sync";
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";

// 手动触发同步:遍历该用户全部账户,逐账户隔离写快照。
// 把 @folio/db 的包装函数绑好 env 后注入编排器(数据访问仍只经 db 包);
// 密钥与全局 key 从 env 取。返回每账户 ok/fail,不含任何密钥/明文凭据。
export const triggerSync = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(({ context }) => {
    const deps: SyncDeps = {
      listAccounts: (userId) => listAccountsByUser(env, userId),
      getEncryptedCredentials: (userId, accountId) =>
        getEncryptedCredentials(env, userId, accountId),
      writeSnapshot: (userId, accountId, input) => writeSnapshot(env, userId, accountId, input),
      secretsKey: env.SECRETS_KEY,
      // provider 全局 key:zerion 等链上源用;manual 无需。逐个 provider 接入时累加。
      globalKeys: { ZERION_API_KEY: env.ZERION_API_KEY },
    };
    return syncUser(deps, context.userId);
  });
