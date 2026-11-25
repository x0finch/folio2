import { Oracle } from "@folio/oracle";
import { DEFAULT_TOP_N } from "@folio/oracle-basic";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { toOption } from "@/lib/core/token-model";
import { serverFn } from "@/lib/server/server-fn";
import { CATALOGUE_CACHE_TTL_S, edgeCached } from "./edge-cache";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// The token picker catalogue: the top-N by market cap is sent whole (~35 KB brotli) and searched locally in the
// browser (components/token-search.ts), so typing needs no round trip or upstream /search and ranks 51-1000 are found too.
export const handleListTokenCatalogue = serverFn("listTokenCatalogue")(function* () {
  tokenLog.debug("catalogue: enter");
  const out = yield* edgeCached(
    "token-catalogue",
    CATALOGUE_CACHE_TTL_S,
    // Already sorted by market cap: order is the rank, so no rank column is sent.
    Effect.map(
      Effect.flatMap(Oracle, (o) => o.tokens.topTokens(DEFAULT_TOP_N)),
      (rows) => rows.map(toOption),
    ),
  );
  tokenLog.debug("catalogue: ok", { count: out.length });
  return out;
});
