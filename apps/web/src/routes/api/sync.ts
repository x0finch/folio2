import { waitUntil } from "cloudflare:workers";
import { syncUserStream } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/lib/server/internal/auth";
import { resolveAuth } from "@/lib/server/internal/auth-session";
import { buildSyncDeps, warmTokensForUser } from "@/lib/server/internal/sync-deps";
import { ndjsonRound } from "@/lib/sync-ndjson";

// POST /api/sync —— 同步当前用户的全部账户,**逐账户以 NDJSON 流回进度**。
//
// 为什么不是前端逐个调 /syncAccount(以前的做法):那是 N 次往返,而且用户得一直停在页面上,
// 关掉标签同步就断在半路。
//
// 「跑」和「看」怎么拆开的在 `lib/sync-ndjson.ts`(纯逻辑,那里有单测)。本文件只剩三件事:
// 鉴权、把依赖接上、把后台任务交给 `waitUntil`。
//
// 为什么是路由而不是 server function:server fn 确实能原样返回流式 Response(类型上
// `TResponse extends Response ? TResponse`,客户端见到 `x-tss-raw` 就直接把 Response 交出去),
// 所以不是做不到。是**测不到**:直接调用 server fn 会跳过 middleware 与 inputValidator
// (TanStack Router #7507 还开着),`requireAuth` 那层就此无法单测;而路由 handler 是个
// 老实的 Request → Response,喂个 Request 就能测。
// 注:`waitUntil` 从 `cloudflare:workers` 直接取(fetch 路径拿不到 ExecutionContext)。

const log = getLogger(["folio", "web", "sync"]);

export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const session = await getAuth().api.getSession({ headers: request.headers });
        let userId: string;
        try {
          userId = resolveAuth(session).userId;
        } catch (err) {
          log.warning("sync stream unauthorized");
          return err instanceof Response ? err : new Response("Unauthorized", { status: 401 });
        }

        const { body, run } = await ndjsonRound(syncUserStream(buildSyncDeps(), userId), {
          // 同步完预热代币缓存(best-effort),让下次总览能 cache-only 富化新价。
          afterRound: () => warmTokensForUser(userId),
          onFatal: (error) => log.error("sync stream failed", { userId, error }),
        });
        waitUntil(run);

        return new Response(body, {
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            // 逐行推,别让任何一层攒着。
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});
