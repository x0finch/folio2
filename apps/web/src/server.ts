import { GlobalDatabase } from "@folio/db";
import { GlobalRefIndexService } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { Cause, Effect, Option } from "effect";
import { withDefaultNoStore } from "./lib/server/entry/cache-headers";
import { configureLogging } from "./lib/server/entry/log";
import { pruneNotesAllUsers } from "./lib/server/entry/note-retention";
import { runAtEdge, withGlobalDb, withOracleWarm } from "./lib/server/oracle";
import { warmAllUsers } from "./lib/server/sync/deps";
import { syncAllUsers } from "./lib/server/sync/round";

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
        // 差量写(#FOL-68):这轮实际落库的 改/增/删 行数。稳态下应接近 0 —— 若长期偏高,
        // 说明上游目录在抖或差量失效,是该查的信号。
        updated: result.updated,
        inserted: result.inserted,
        deleted: result.deleted,
      });
    }),
  );

// cron 扫「有哪些用户」那一条。**没有 userId**(它问的正是这个),所以它来自 `GlobalDatabase`
// —— db 那张「表里没有『谁的』这回事」的门票,不是 per-user 的 `Database`。
const listUserIds = withGlobalDb(Effect.flatMap(GlobalDatabase, (db) => db.accounts.listUserIds()));

// 每天那趟顺带剪掉保留期外的展示 note(#456)。
//
// **搭在这个 trigger 上而不是新开一个**:它要的就是「每天一次」,而另一个 trigger 是每小时
// (#446 起)—— 挂那儿会一天跑 24 遍同一件事。
//
// **排在刷表之前,而且整趟自己兜住。** 排在后面的话,一个**持续**失败的刷表(上游改了格式、
// 配额用光)会把剪 note 永久停掉,而不只是推迟一天 —— 那时存储会一直长而没有任何迹象。
// 自己兜住则保证反方向也不会发生:剪 note 出问题不会挡住刷表(新币认不出来是更重的后果),
// 也不会把整趟 cron 拖成异常收尾。两个方向都不再互相牵连。
//
// 兜的是 `Cause` 不是类型化失败:`listUserIds` 那步抛的是 defect(db 挂了),
// `catchAll` 接不住(同 warmAllUsers 的注释)。
const pruneNotesSweep = (cron: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const userIds = yield* listUserIds;
    const pruned = yield* pruneNotesAllUsers(userIds);
    cronLog.info("prune notes done", { cron, ...pruned });
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() =>
        cronLog.warn("prune notes sweep failed", { cron, error: Cause.pretty(cause) }),
      ),
    ),
  );

// 全量 sweep:同步每个用户 → 逐用户预热代币缓存。
// 预热那步**逐用户各自兜住**:一个用户失败不拖累其余、也不让这次 cron 以异常收尾(#375)。
// sweep 本身不兜 —— 它失败了就该上抛、就该可见。
const sweepAllUsers = (cron: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const userIds = yield* listUserIds;
    cronLog.info("cron sweep start", { cron, users: userIds.length });
    const result = yield* syncAllUsers(userIds);
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
  //   · GLOBAL_REF_INDEX_CRON(每天 23:00)—— 先剪过期 note(#456),再刷全局代币映射表
  //   · 其余(每小时 :30,#446)—— 全量 sync sweep
  // 拆两个 trigger 而不是挤一次:拉几 MB JSON + 写几万行是重活,与 sweep 挤一次调用有超预算风险。
  // waitUntil 保证跑完才结束本次调用。env/ctx 由运行时传入;env 不单独取用
  // (configureLogging / syncAllUsers / warmAllUsers / oracleWarm 都走 cloudflare:workers 全局)。
  async scheduled(controller: ScheduledController, _env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await configureLogging();
        try {
          // **整趟一个 effect,只跑一次。** 两个分支各自是一个 effect(内部已装好各自要的那层),
          // 边缘只在这里 —— 官方那句「`run*` 尽量放在程序的边缘」在 cron 这条路上就是这个形状。
          await runAtEdge(
            controller.cron === GLOBAL_REF_INDEX_CRON
              ? Effect.zipRight(
                  pruneNotesSweep(controller.cron),
                  refreshGlobalRefIndex(controller.cron),
                )
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
