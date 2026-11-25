import { FIAT_NAMER } from "@folio/oracle-basic";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { NAMER } from "@/lib/server/oracle";
import { serverFn } from "@/lib/server/server-fn";
import { priceTickets } from "./pricing";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// Fetches the current price to prefill the unit price after selection. An undecodable ticket counts as no selection
// (it came from the network); both the current upstream's and the `fiat` namer are allowed (same set as mintHolding).
export const TokenPriceInput = z.object({ ticket: z.string().min(1) });

export const handleGetTokenPrice = serverFn("getTokenPrice")(function* (
  data: z.infer<typeof TokenPriceInput>,
) {
  // Same routing as batch pricing (priceTickets); one ticket, first result, null if unpriced. No warm: relies on the cache
  // already warmed by the loader / listFiatOptions.
  const [priced] = yield* priceTickets([data.ticket], { namers: [NAMER, FIAT_NAMER] });
  tokenLog.debug("tokenPrice: ok", { found: priced != null });
  return priced
    ? { unitPrice: priced.unitPrice, change24h: priced.change24h, asOf: priced.asOf }
    : null;
});
