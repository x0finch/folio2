import { env } from "cloudflare:workers";
import { getLatestSnapshotByUser, getRawCreds, listAccountsByUser, writeSnapshot } from "@folio/db";
import { type SyncDeps, syncUser } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";
import { revalueManual } from "../revalue";
import { buildTokens, warmTokens } from "./tokens";

// 同步后预热代币缓存:取该用户最新快照的全部余额 → warm(top-N + 逐 spot/manual 行懒解析)。
// best-effort(warmTokens 内部吞错),让下次总览能 cache-only 富化出价/logo/涨跌。cron 与手动 sync 共用。
export async function warmTokensForUser(bindings: Cloudflare.Env, userId: string): Promise<void> {
  const snapshots = await getLatestSnapshotByUser(bindings, userId);
  await warmTokens(
    buildTokens(bindings),
    snapshots.flatMap((s) => s.balances),
  );
}

// 把 @folio/db 的包装函数绑好 env 后装进编排器的注入式依赖(数据访问仍只经 db 包);
// 密钥与全局 key 从 env 取。triggerSync(手动)与 cron(scheduled,见 src/server.ts)共用,
// 故抽成接收 bindings 的工厂(消除两处重复的 env→deps + globalKeys 装配)。
export function buildSyncDeps(bindings: Cloudflare.Env): SyncDeps {
  const tokens = buildTokens(bindings);
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
    // 结构化日志:sync 的每账户结果/重试经此 logger 记(userId 显式带;请求路径还会经 withContext 带 ALS 上下文)。
    log: getLogger(["folio", "sync"]),
    // 写快照前重估(P7.4.2):仅 manual 用市场价改 usdValue(@folio/sync 不依赖 token 层,逻辑注入在此)。
    revalue: (type, balances) => revalueManual(tokens, type, balances),
  };
}

// 手动触发同步:遍历该用户全部账户,逐账户隔离写快照。返回每账户 ok/fail,不含任何密钥/明文凭据。
// userId 经 requireAuth 的 withContext 自动带入下游日志(ALS);此处再记一条触发汇总。
export const triggerSync = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const result = await syncUser(buildSyncDeps(env), context.userId);
    const ok = result.results.filter((r) => r.ok).length;
    const skipped = result.results.filter((r) => r.skipped).length;
    getLogger(["folio", "web", "sync"]).info("manual sync triggered", {
      accounts: result.results.length,
      ok,
      skipped,
      failed: result.results.length - ok - skipped,
    });
    // 预热代币缓存(best-effort,inline:同步本就耗时,可接受;首次有按需取价的额外延迟)。
    await warmTokensForUser(env, context.userId);
    return result;
  });
