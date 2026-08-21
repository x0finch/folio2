import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/lib/server/internal/auth";
import { resolveAuth } from "@/lib/server/internal/auth-session";
import { exportStream } from "@/lib/server/io/export-stream";
import { runAtEdge, withRequest } from "@/lib/server/internal/oracle";

// GET /api/export —— 把用户全部数据导成 NDJSON 文件(流式、分页、剥密钥)。鉴权同其它 server fn。
export const Route = createFileRoute("/api/export")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const session = await getAuth().api.getSession({ headers: request.headers });
        let userId: string;
        try {
          userId = resolveAuth(session).userId;
        } catch (err) {
          getLogger(["folio", "web", "export"]).warning("export unauthorized");
          return err instanceof Response ? err : new Response("Unauthorized", { status: 401 });
        }
        getLogger(["folio", "web", "export"]).info("export started", { userId });

        const body = await runAtEdge(withRequest(userId, exportStream()));
        return new Response(body, {
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "content-disposition": 'attachment; filename="folio-export.ndjson"',
          },
        });
      },
    },
  },
});
