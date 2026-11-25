import { Oracle } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { toOption } from "@/lib/core/token-model";
import { serverFn } from "@/lib/server/server-fn";
import { edgeCached, SEARCH_CACHE_TTL_S } from "./edge-cache";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// Picker autocomplete against the upstream; only reached when the local catalogue can't satisfy the query, so
// terms are mostly long-tail tokens.
export const ListTokensInput = z.object({ query: z.string() });

export const handleListTokens = serverFn("listTokens")(function* (
  data: z.infer<typeof ListTokensInput>,
) {
  const q = data.query.trim();
  tokenLog.debug("searchTokens: enter", { query: q });
  if (!q) return [];
  // Thrown errors are logged centrally by the requireAuth middleware.
  const out = yield* edgeCached(
    `token-search?q=${encodeURIComponent(q)}`,
    SEARCH_CACHE_TTL_S,
    Effect.map(
      Effect.flatMap(Oracle, (o) => o.tokens.search(q)),
      (rows) => rows.map(toOption),
    ),
  );
  tokenLog.debug("searchTokens: ok", { query: q, count: out.length });
  return out;
});
