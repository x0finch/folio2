import { z } from "zod";
import type { PreferCurrency } from "@/lib/hooks/use-prefer-currency";
import { serverFn } from "@/lib/server/server-fn";
import { resolveCurrency } from "./currency-detect";
import { displayRate } from "./fx";

// The browser picks the display currency (localStorage); the server only supplies its USD rate, so the code
// is a parameter. Rate lookup (USD / cache, no network) is `displayRate`. If no rate is available the whole
// result falls back to USD: showing EUR with a rate of 1 is worse. requireAuth is applied in index (rates are per-user).
export const CurrencyPreferenceInput = z.object({ code: z.string() });

export const handleGetCurrencyPreference = serverFn("getCurrencyPreference")(function* (
  data: z.infer<typeof CurrencyPreferenceInput>,
) {
  const currency = resolveCurrency(data.code);
  const rate = yield* displayRate(currency.code);
  const preference: PreferCurrency =
    rate == null ? { currency: resolveCurrency("USD"), rate: 1 } : { currency, rate };
  return preference;
});
