import { syncUser } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";
import { buildSyncDeps, warmTokensForUser } from "./sync-deps";

// 手动触发同步:遍历该用户全部账户,逐账户隔离写快照。返回每账户 ok/fail,不含任何密钥/明文凭据。
// userId 经 requireAuth 的 withContext 自动带入下游日志(ALS);此处再记一条触发汇总。
// 编排装配在 ./sync-deps(server-only)—— 本文件不引 cloudflare:workers,故 triggerSync 可安全被客户端 import。
export const triggerSync = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const result = await syncUser(buildSyncDeps(), context.userId);
    const ok = result.results.filter((r) => r.ok).length;
    const skipped = result.results.filter((r) => r.skipped).length;
    getLogger(["folio", "web", "sync"]).info("manual sync triggered", {
      accounts: result.results.length,
      ok,
      skipped,
      failed: result.results.length - ok - skipped,
    });
    // 预热代币缓存(best-effort,inline:同步本就耗时,可接受;首次有按需取价的额外延迟)。
    await warmTokensForUser(context.userId);
    return result;
  });
