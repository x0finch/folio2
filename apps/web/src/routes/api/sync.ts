import { waitUntil } from "cloudflare:workers";
import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { runAtEdge } from "@/lib/server/oracle";
import { requireUserId } from "@/lib/server/session/route-auth";
import { syncStream } from "@/lib/server/sync/stream";

const log = getLogger(["folio", "web", "sync"]);

// 路由文件只做 HTTP 入口转发;实现见 lib/server/sync/stream.ts。
// waitUntil 从 cloudflare:workers 取(fetch 路径拿不到 ExecutionContext)。

export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const userId = await requireUserId(request);
        if (userId instanceof Response) {
          log.warning("sync stream unauthorized");
          return userId;
        }

        const { body, run } = await runAtEdge(syncStream(userId));
        waitUntil(run);
        return new Response(body, {
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});
