import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { historyResolution } from "@/lib/core/history-range";
import type { TokenValueHistoryRaw } from "@/lib/core/portfolio";

export const TokenValueHistoryInput = z.object({
  key: z.string().min(1),
  since: z.number().int().nonnegative().optional(),
  range: z.enum(["7d", "30d", "1y", "all"]).optional(),
});

// Per-account spot value history of one holding (token_id) in the window. Identity is frozen into snapshot
// rows, so no server-side identity aggregation. Totals and caps are done in SQL (bounded rows per account per
// bucket); the browser rebuilds and downsamples (`tokenValueHistoryFromRaw`).
export const handleGetTokenValueHistory = Effect.fn("getTokenValueHistory")(function* (
  data: z.infer<typeof TokenValueHistoryInput>,
) {
  const db = yield* Database;
  const resolution = historyResolution({ range: data.range, since: data.since });
  const rows = yield* db.snapshots.listTokenValueTotals(
    data.key,
    data.since,
    resolution === "hourly" ? "snapshot" : resolution === "daily" ? "day" : "sampled",
  );
  return { rows, sampled: resolution === "sampled" } satisfies TokenValueHistoryRaw;
});
