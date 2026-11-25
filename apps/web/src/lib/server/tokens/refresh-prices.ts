import { FIAT_NAMER } from "@folio/oracle-basic";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { NAMER } from "@/lib/server/oracle";
import { serverFn } from "@/lib/server/server-fn";
import { priceTickets } from "./pricing";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// SWR price refresh for the picker: tickets -> price + change for visible rows with stale or missing prices.
// POST because dozens of tickets in a GET query overflow the URL (414), and it's a user-triggered live refresh that
// shouldn't hit the edge cache. Creates no rows and writes no cache.
export const RefreshTokenPricesInput = z.object({
  tickets: z.array(z.string().min(1)).max(200),
});

export const handleRefreshTokenPrices = serverFn("refreshTokenPrices")(function* (
  data: z.infer<typeof RefreshTokenPricesInput>,
) {
  // Both the current upstream's and the `fiat` namer are allowed (NAMER only would drop fiat holdings and leave the
  // price column "—"). Fiat routing is in the pure `priceTickets`, shared with the other picker endpoint; fiat is
  // read from the FX cache only, never warmed here.
  const out = yield* priceTickets(data.tickets, { namers: [NAMER, FIAT_NAMER] });
  tokenLog.debug("refreshTokenPrices: ok", { asked: data.tickets.length, got: out.length });
  return out;
});
