import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { runForUser } from "@/lib/server/runtime";
import { requireUserId } from "@/lib/server/session/route-auth";
import { startSyncRound } from "@/lib/server/sync/round";
import { syncRoundView } from "@/lib/server/sync/status";

const log = getLogger(["folio", "web", "sync"]);

// Opens the round and enqueues one job per account, then returns; progress is polled. No upstream
// calls and no waitUntil here: waitUntil work counts against this request's 10ms CPU budget.
// Opening is idempotent, so a repeated POST returns the running round instead of a second one.
//
// Malformed bodies fall back to defaults rather than 400: it's a button/page-entry action.
// `auto` = the silent catch-up round, which skips fresh accounts; manual sync forces all.
const Body = z
  .object({ portfolioId: z.string().min(1).optional(), auto: z.boolean().optional() })
  .catch({});

const parseBody = async (request: Request): Promise<{ portfolioId?: string; auto: boolean }> => {
  try {
    const body = Body.parse(await request.json());
    return { portfolioId: body.portfolioId, auto: body.auto ?? false };
  } catch {
    return { auto: false };
  }
};

export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const userId = await requireUserId(request);
        if (userId instanceof Response) {
          log.warning("sync round unauthorized");
          return userId;
        }

        const { portfolioId, auto } = await parseBody(request);
        const out = await runForUser(userId, startSyncRound({ portfolioId, auto }));
        // Row deleted in between (user cascade): report a conflict rather than a phantom round.
        if (out.round == null) {
          return Response.json(null, { status: 409, headers: { "cache-control": "no-store" } });
        }

        // Return the current state so the panel can draw before the first poll (1.5s).
        return Response.json(syncRoundView(out.round, Date.now()), {
          headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
        });
      },
    },
  },
});
