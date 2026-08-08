import { GlobalRefIndexService } from "@folio/oracle";
import { syncAllUsers } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { Effect, Option } from "effect";
import { withDefaultNoStore } from "./lib/server/internal/cache-headers";
import { db } from "./lib/server/internal/db";
import { configureLogging } from "./lib/server/internal/log";
import { runAtEdge, withOracleWarm } from "./lib/server/internal/oracle";
import { buildSyncDeps, warmAllUsers } from "./lib/server/internal/sync-deps";

// 自定义 worker 入口:用 createServerEntry 包 TanStack 的默认 fetch(SSR/server fns),
// 再补一个 CF scheduled() 处理器跑定时同步(cron 只触发 scheduled,不触发 fetch)。
// wrangler.jsonc 的 main 指向本文件(取代默认的 @tanstack/react-start/server-entry)。
// 两个入口都先 configureLogging()(幂等)再处理 → LogTape sink/上下文就绪。
const cronLog = getLogger(["folio", "cron"]);
const webLog = getLogger(["folio", "web"]);

// 刷全局映射表那个 trigger 的表达式(与 wrangler.jsonc 的 triggers.crons 第一条一致)。
// 硬编码在这里是 Workers 的形状使然:分支只能靠 controller.cron 的字符串比对。
const GLOBAL_REF_INDEX_CRON = "0 23 * * *";

// 刷 `global_token_ref_index`:拉整份币目录 → 转换(在 adapter 里)→ 一次整份灌(分批写)。
// 与用户无关,所以不枚举用户。失败会上抛到外层统一记 error —— 刷表挂了必须可见,
// 否则新币会一直认不出来而没有任何迹象。
const refreshGlobalRefIndex = (cron: string): Effect.Effect<void, Error> =>
  withOracleWarm(
    Effect.gen(function* () {
      const svc = yield* GlobalRefIndexService;
      const before = yield* svc.refreshedAt();
      cronLog.info("global ref index refresh start", {
        cron,
        lastRefreshedAt: Option.getOrNull(before),
      });
      const result = yield* svc.warm();
      cronLog.info("global ref index refresh done", {
        cron,
        rows: result.rows,
        skipped: result.skipped,
        unmatchedPlatforms: result.unmatchedPlatforms.length,
      });
    }),
  );

// 全量 sweep:同步每个用户 → 逐用户预热代币缓存。
// 预热那步**逐用户各自兜住**:一个用户失败不拖累其余、也不让这次 cron 以异常收尾(#375)。
// sweep 本身不兜 —— 它失败了就该上抛、就该可见。
const sweepAllUsers = (cron: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const userIds = yield* Effect.promise(() => db.listUserIdsWithAccounts());
    cronLog.info("cron sweep start", { cron, users: userIds.length });
    const result = yield* Effect.tryPromise({
      try: () => syncAllUsers(buildSyncDeps(), userIds),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    });
    cronLog.info("cron sweep done", {
      cron,
      users: result.users,
      ok: result.ok,
      failed: result.failed,
      skipped: result.skipped,
    });
    // sweep 后预热每用户代币缓存(best-effort),供次日总览 cache-only 富化。
    const warm = yield* warmAllUsers(userIds);
    cronLog.info("cron warm done", { cron, ...warm });
  });

const serverEntry = createServerEntry({
  fetch: async (request) => {
    await configureLogging();
    try {
      // 出口统一补「不可缓存」的默认档 —— SSR 文档和 server fn 响应都从这里出去,而 CF 的
      // 边缘缓存键不含 Cookie,漏一个就会把某个用户的页面发给另一个用户(见 cache-headers.ts)。
      // 放在这里而不是各路由里:安全默认必须在**唯一出口**上,否则新加的路由默认是漏的。
      return withDefaultNoStore(await handler.fetch(request));
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

  // 两个定时任务共一个 scheduled(),按 controller.cron 分支(见 wrangler.jsonc 的 triggers):
  //   · GLOBAL_REF_INDEX_CRON(23:00)—— 刷全局代币映射表
  //   · 其余(00:00)—— 全量 sync sweep
  // 拆两个 trigger 而不是挤一次:拉几 MB JSON + 写几万行是重活,与 sweep 挤一次调用有超预算风险。
  // waitUntil 保证跑完才结束本次调用。env/ctx 由运行时传入;env 不单独取用
  // (configureLogging / db / buildSyncDeps / oracleWarm 都走 cloudflare:workers 全局)。
  async scheduled(controller: ScheduledController, _env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await configureLogging();
        try {
          // **整趟一个 effect,只跑一次。** 两个分支各自是一个 effect(内部已装好各自要的那层),
          // 边缘只在这里 —— 官方那句「`run*` 尽量放在程序的边缘」在 cron 这条路上就是这个形状。
          await runAtEdge(
            controller.cron === GLOBAL_REF_INDEX_CRON
              ? refreshGlobalRefIndex(controller.cron)
              : sweepAllUsers(controller.cron),
          );
        } catch (err) {
          // waitUntil 里的抛错会变成静默的 unhandled rejection —— 集中打日志再上抛,cron 失败才可见。
          cronLog.error("cron threw", {
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
