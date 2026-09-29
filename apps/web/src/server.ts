import { GlobalDatabase } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { Effect } from "effect";
import { withDefaultNoStore } from "./lib/server/entry/cache-headers";
import { configureLogging } from "./lib/server/entry/log";
import { pokeRunner } from "./lib/server/jobs/queue";
import { fanOutDaily } from "./lib/server/jobs/schedule";
import { runAtEdge, withGlobalDb } from "./lib/server/runtime";
import { fanOutAllUsers } from "./lib/server/sync/round";

// 自定义 worker 入口:用 createServerEntry 包 TanStack 的默认 fetch(SSR/server fns),
// 再补一个 CF scheduled() 处理器跑定时任务(cron 只触发 scheduled,不触发 fetch)。
// 后台活不在这里跑:它们投给运行器那个 Durable Object(`JobRunner`,FOL-100 / ADR 0058),
// 由它的 alarm 一件一件跑 —— DO 类必须从 main 模块具名导出,wrangler 才找得到它(见文件末尾)。
// wrangler.jsonc 的 main 指向本文件(取代默认的 @tanstack/react-start/server-entry)。
// 两个入口都先 configureLogging()(幂等)再处理 → LogTape sink/上下文就绪。
const cronLog = getLogger(["folio", "cron"]);
const webLog = getLogger(["folio", "web"]);

// 每天那个 trigger 的表达式(与 wrangler.jsonc 的 triggers.crons 第一条一致)。
// 硬编码在这里是 Workers 的形状使然:分支只能靠 controller.cron 的字符串比对。
//
// **它以前还刷全局代币映射表**(拉 2.6 MB 币目录 + 与几万行比对):生产 480–520ms CPU、7 次里 2 次
// exceededCpu —— 免费计划一次调用只有 10ms。FOL-85 起那一趟在 GitHub Actions 里跑
// (`.github/workflows/ref-index-refresh.yml` → `scripts/ref-index/refresh.ts`,ADR 0056),
// 这个 trigger 只剩投每天的逐用户活。
const DAILY_CRON = "0 23 * * *";

// cron 扫「有哪些用户」那一条。**没有 userId**(它问的正是这个),所以它来自 `GlobalDatabase`
// —— db 那张「表里没有『谁的』这回事」的门票,不是 per-user 的 `Database`。
const listUserIds = withGlobalDb(Effect.flatMap(GlobalDatabase, (db) => db.accounts.listUserIds()));

// 每天那趟的逐用户活(FOL-88):每个用户一条 `prune-notes`(剪保留期外的展示 note,#456)与一条
// `catalogue`(目录一周 TTL,一天投一次足够)。**这里只投,不剪、不出网** —— 以前剪 note 在这一次
// 调用里逐用户串行跑,现在每个用户是 consumer 的一次调用、自己一份预算。
//
// **搭在这个 trigger 上而不是新开一个**:它要的就是「每天一次」,而另一个 trigger 是每小时
// (#446 起)—— 挂那儿会一天投 24 遍同一件事。
//
// **不再自己兜住**:以前它排在刷全局映射表之前、兜住是为了「投递出问题不挡刷表」;刷表挪走之后
// 这一趟就是整次调用的全部,失败就该上抛到 `scheduled()` 那一处记 error(与 sweep 同一个口径)。
const enqueueDailyJobs = (cron: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const userIds = yield* listUserIds;
    const result = yield* fanOutDaily(userIds);
    cronLog.info("daily jobs enqueued", { cron, users: userIds.length, ...result });
  });

// 全量 sweep(FOL-86):**只开轮、只投消息,不碰上游**。每个账户一条 `sync-account`、每个用户补
// `prices` / `fx` / `platforms` / `defi-logos` 各一条(FOL-88,见 jobs/schedule),真活在运行器的 alarm
// 里一件一次调用地跑 —— 免费计划每次 cron 调用只有 10ms CPU /
// 50 subrequest,cron 那一次调用跑完所有账户时,42% 的整点 sweep 死在 exceededCpu。
// 逐用户各自兜住在 `fanOutAllUsers` 里;sweep 本身(列用户那一步)不兜 —— 它失败了就该上抛、就该可见。
const sweepAllUsers = (cron: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const userIds = yield* listUserIds;
    cronLog.info("cron sweep start", { cron, users: userIds.length });
    const result = yield* fanOutAllUsers(userIds);
    cronLog.info("cron sweep enqueued", { cron, ...result });
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
  //   · DAILY_CRON(每天 23:00)—— 投每天的逐用户活(剪 note / 目录,FOL-88)
  //   · 其余(每小时 :30,#446)—— 全量 sync sweep(FOL-86 起只投活,见 `sweepAllUsers`)
  // 全局代币映射表不在这里刷了(FOL-85,见 DAILY_CRON 上面那段)。
  // 两条都**顺手戳一下运行器**(`pokeRunner`):投活本身已经会定 alarm,戳这一下是兜底 —— alarm 链
  // 万一断了,表里还排着的活最迟一小时后被捡起来(ADR 0058「不只靠 getAlarm」)。投活那一步失败了
  // 也照戳(`ensuring`),戳本身出错不盖掉投活的那个错(`exit` 把它收住)。
  // waitUntil 保证跑完才结束本次调用。env/ctx 由运行时传入;env 不单独取用
  // (configureLogging / fanOutAllUsers 都走 cloudflare:workers 全局)。
  async scheduled(controller: ScheduledController, _env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await configureLogging();
        try {
          // **整趟一个 effect,只跑一次。** 两个分支各自是一个 effect(内部已装好各自要的那层),
          // 边缘只在这里 —— 官方那句「`run*` 尽量放在程序的边缘」在 cron 这条路上就是这个形状。
          await runAtEdge(
            (controller.cron === DAILY_CRON
              ? enqueueDailyJobs(controller.cron)
              : sweepAllUsers(controller.cron)
            ).pipe(Effect.ensuring(Effect.exit(pokeRunner))),
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

// 后台任务运行器(FOL-100,ADR 0058)。wrangler.jsonc 的 `durable_objects` 按这个名字绑定。
export { JobRunner } from "./lib/server/jobs/durable";
