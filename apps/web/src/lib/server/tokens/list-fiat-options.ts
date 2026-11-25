import { Oracle } from "@folio/oracle";
import { Clock, Effect, Option } from "effect";
import { z } from "zod";
import { pickLocale } from "@/lib/i18n/detect";
import { serverFn } from "@/lib/server/server-fn";
import { buildFiatOptions } from "./fiat-options";

// The picker's fiat group: tickets are built server-side (the client never builds tokenRefs / tickets), names are
// localized by the caller's locale. Static, no network, no per-user data: no edge cache, no rows.
export const ListFiatOptionsInput = z.object({ locale: z.string() });

export const handleListFiatOptions = serverFn("listFiatOptions")(function* (
  data: z.infer<typeof ListFiatOptionsInput>,
) {
  // Unrecognized locale falls back to the default language.
  const base = buildFiatOptions(pickLocale(data.locale, null));
  // A fiat "price" is its FX rate (USD = 1), so the price column doesn't show "—". Cache-only, no network: the `fx`
  // queue job warms rates hourly. asOf = now so the dropdown's SWR treats it as fresh and doesn't refetch. Missing
  // from cache: no price (degrade to "—"). No 24h change for fiat.
  const { fx } = yield* Oracle;
  const asOf = yield* Clock.currentTimeMillis;
  return yield* Effect.forEach(base, (o) =>
    Effect.map(fx.resolve(o.symbol), (price) =>
      Option.isSome(price) ? { ...o, price: price.value, asOf } : o,
    ),
  );
});
