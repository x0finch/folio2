import { listUserIdsWithAccounts } from "@folio/db";
import { syncAllUsers } from "@folio/sync";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { buildSyncDeps } from "./lib/server/sync";

// 自定义 worker 入口:用 createServerEntry 包 TanStack 的默认 fetch(SSR/server fns),
// 再补一个 CF scheduled() 处理器跑定时同步(cron 只触发 scheduled,不触发 fetch)。
// wrangler.jsonc 的 main 指向本文件(取代默认的 @tanstack/react-start/server-entry)。
const serverEntry = createServerEntry({
  fetch: (request) => handler.fetch(request),
});

export default {
  ...serverEntry,

  // 每日定时全量同步(triggers.crons)。无登录用户 → 用系统级 listUserIdsWithAccounts 枚举所有
  // 有账户的用户,逐用户逐账户隔离 sweep。waitUntil 保证 sweep 跑完才结束本次调用。
  async scheduled(controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const userIds = await listUserIdsWithAccounts(env);
        const result = await syncAllUsers(buildSyncDeps(env), userIds);
        console.log(
          `[cron] ${controller.cron} swept users=${result.users} ok=${result.ok} failed=${result.failed}`,
        );
      })(),
    );
  },
};
