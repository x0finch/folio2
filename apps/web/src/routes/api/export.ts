import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { exportData } from "@/lib/server/io/export-stream";
import { runForUser } from "@/lib/server/runtime";
import { requireUserId } from "@/lib/server/session/route-auth";

const log = getLogger(["folio", "web", "export"]);

export const Route = createFileRoute("/api/export")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const userId = await requireUserId(request);
        if (userId instanceof Response) {
          log.warning("export unauthorized");
          return userId;
        }
        log.info("export started", { userId });
        const body = await runForUser("exportData", userId, exportData());
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
