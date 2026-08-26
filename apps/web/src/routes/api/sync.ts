import { waitUntil } from "cloudflare:workers";
import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { runAtEdge } from "@/lib/server/oracle";
import { requireUserId } from "@/lib/server/session/route-auth";
import { syncStream } from "@/lib/server/sync/stream";

const log = getLogger(["folio", "web", "sync"]);

// 路由文件只做 HTTP 入口转发;实现见 lib/server/sync/stream.ts。
// waitUntil 从 cloudflare:workers 取(fetch 路径拿不到 ExecutionContext)。

// 请求体只带「我在看哪个组合」(ADR 0047)。**不收账户名单** —— 这一轮跑哪些账户由服务端算。
// 空 body / 坏 JSON / 认不出的 id 一律当没带 = 默认组合:这是个按钮触发的动作,不该因为一个
// 参数没解出来就 400。
const Body = z.object({ portfolioId: z.string().min(1).optional() }).catch({});

const portfolioOf = async (request: Request): Promise<string | undefined> => {
  try {
    return Body.parse(await request.json()).portfolioId;
  } catch {
    return undefined;
  }
};

export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const userId = await requireUserId(request);
        if (userId instanceof Response) {
          log.warning("sync stream unauthorized");
          return userId;
        }

        const { body, run } = await runAtEdge(syncStream(userId, await portfolioOf(request)));
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
