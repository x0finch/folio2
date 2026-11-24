import { queryOptions } from "@tanstack/react-query";
import { getCurrencyPreference } from "@/lib/server/preferences";
import { RETRY, STALE_TIME, shouldRetry } from "./constants";
import { preferenceKeys } from "./keys";

// Only the display currency's FX rate: currency code and UI language live in the browser (localStorage). The code is in
// the query key, so a switch changes key and the switcher prefetches the new key before writing the code, avoiding a skeleton.
export const currencyPreferenceQuery = (code: string) =>
  queryOptions({
    queryKey: preferenceKeys.currency(code),
    queryFn: () => getCurrencyPreference({ data: { code } }),
    staleTime: STALE_TIME.settings,
    // The shell can't render without it, so never give up (same as portfolioListQuery).
    retry: (failureCount, error) => shouldRetry(failureCount, error, RETRY.forever),
  });
