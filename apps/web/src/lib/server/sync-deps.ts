import { env } from "cloudflare:workers";
import type { SyncDeps } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { revalueManual } from "../revalue";
import { db } from "./db";
import { buildTokens, warmTokens } from "./tokens";

// server-only 编排装配(引 cloudflare:workers)。独立于 sync.ts —— triggerSync(server fn,被客户端 import)
// 只在其 handler 内引用本模块,handler 被剥离后客户端不会拉进 cloudflare:workers。cron(server.ts)直接引本模块。
// 数据访问经全局 db 门面;密钥/全局 key/tokens 走 cloudflare:workers 全局 env(fetch 与 scheduled 均可用)。

// 同步后预热代币缓存:取该用户最新快照的全部余额 → warm(top-N + 逐 spot/manual 行懒解析)。
// best-effort(warmTokens 内部吞错),让下次总览能 cache-only 富化出价/logo/涨跌。cron 与手动 sync 共用。
export async function warmTokensForUser(userId: string): Promise<void> {
  const snapshots = await db.getLatestSnapshotByUser(userId);
  await warmTokens(
    buildTokens(env),
    snapshots.flatMap((s) => s.balances),
  );
}

// 装配编排器的注入式依赖。真正的 DI 缝是这里返回的 SyncDeps(syncUser 只认注入的 deps);
// triggerSync(手动)与 cron(scheduled)共用。
export function buildSyncDeps(): SyncDeps {
  const tokens = buildTokens(env);
  return {
    listAccounts: (userId) => db.listAccountsByUser(userId),
    getRawCreds: (userId, accountId) => db.getRawCreds(userId, accountId),
    writeSnapshot: (userId, accountId, input) => db.writeSnapshot(userId, accountId, input),
    secretsKey: env.SECRETS_KEY,
    // provider 全局 key:各 provider 按 usesGlobalKeys 只拿到自己声明的(见 @folio/sync scopeGlobalKeys)。
    globalKeys: {
      ZERION_API_KEY: env.ZERION_API_KEY,
      COINSTATS_API_KEY: env.COINSTATS_API_KEY,
    },
    // 结构化日志:sync 的每账户结果/重试经此 logger 记(userId 显式带;请求路径还会经 withContext 带 ALS 上下文)。
    log: getLogger(["folio", "sync"]),
    // 写快照前重估(P7.4.2):仅 manual 用市场价改 usdValue(@folio/sync 不依赖 token 层,逻辑注入在此)。
    revalue: (type, balances) => revalueManual(tokens, type, balances),
  };
}
