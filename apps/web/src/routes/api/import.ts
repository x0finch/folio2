import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { importData } from "@/lib/server/io/import-data";
import { runForUser } from "@/lib/server/runtime";
import { requireUserId } from "@/lib/server/session/route-auth";

const log = getLogger(["folio", "web", "import"]);

export const Route = createFileRoute("/api/import")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const userId = await requireUserId(request);
        if (userId instanceof Response) {
          log.warning("import unauthorized");
          return userId;
        }
        const reader = request.body?.getReader();
        if (!reader) return new Response("empty body", { status: 400 });

        const outcome = await runForUser("importData", userId, importData(reader));
        if (outcome.kind === "rejected") {
          log.warning("import rejected", { userId, error: outcome.message });
          return new Response(outcome.message, { status: 400 });
        }
        if (outcome.kind === "failed") {
          log.error("import failed", { userId, error: outcome.message });
          return new Response("import failed", { status: 500 });
        }
        log.info("import complete", { userId, ...outcome.counts });
        return Response.json({ imported: outcome.counts });
      },
    },
  },
});
