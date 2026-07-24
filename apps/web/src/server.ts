import { syncAllUsers } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { configureLogging } from "./lib/log";
import { db } from "./lib/server/internal/db";
import { buildSyncDeps, warmTokensForUser } from "./lib/server/internal/sync-deps";

// 自定义 worker 入口:用 createServerEntry 包 TanStack 的默认 fetch(SSR/server fns),
// 再补一个 CF scheduled() 处理器跑定时同步(cron 只触发 scheduled,不触发 fetch)。
// wrangler.jsonc 的 main 指向本文件(取代默认的 @tanstack/react-start/server-entry)。
// 两个入口都先 configureLogging()(幂等)再处理 → LogTape sink/上下文就绪。
const cronLog = getLogger(["folio", "cron"]);
const webLog = getLogger(["folio", "web"]);

const serverEntry = createServerEntry({
  fetch: async (request) => {
    await configureLogging();
    try {
      return await handler.fetch(request);
    } catch (err) {
      // 顶层兜底:SSR/loader 等非 server-fn 路径抛错不过 requireAuth,不打就无处可见。
      // 只记 pathname(不带 query,守 P6.7)。
      webLog.error("fetch handler threw", {
        path: new URL(request.url).pathname,
        error: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string })?.code,
      });
      throw err;
    }
  },
});

export default {
  ...serverEntry,

  // 每日定时全量同步(triggers.crons)。无登录用户 → 用系统级 listUserIdsWithAccounts 枚举所有
  // 有账户的用户,逐用户逐账户隔离 sweep。waitUntil 保证 sweep 跑完才结束本次调用。
  // env/ctx 由运行时传入;env 不再单独取用(configureLogging / db / buildSyncDeps 都走 cloudflare:workers 全局)。
  async scheduled(controller: ScheduledController, _env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await configureLogging();
        try {
          const userIds = await db.listUserIdsWithAccounts();
          cronLog.info("cron sweep start", { cron: controller.cron, users: userIds.length });
          const result = await syncAllUsers(buildSyncDeps(), userIds);
          cronLog.info("cron sweep done", {
            cron: controller.cron,
            users: result.users,
            ok: result.ok,
            failed: result.failed,
            skipped: result.skipped,
          });
          // sweep 后预热每用户代币缓存(best-effort),供次日总览 cache-only 富化。
          for (const userId of userIds) await warmTokensForUser(userId);
        } catch (err) {
          // waitUntil 里的抛错会变成静默的 unhandled rejection —— 集中打日志再上抛,cron 失败才可见。
          cronLog.error("cron sweep threw", {
            cron: controller.cron,
            error: err instanceof Error ? err.message : String(err),
            code: (err as { code?: string })?.code,
          });
          throw err;
        }
      })(),
    );
  },
};
