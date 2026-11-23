import { queryOptions } from "@tanstack/react-query";
import { readJson } from "@/lib/core/json-response";
import {
  getTokenEnrichment,
  listFiatOptions,
  listTokenCatalogue,
  listTokens,
} from "@/lib/server/tokens";
import { STALE_TIME } from "./constants";
import { tokenKeys } from "./keys";

// Picker reads. `getTokenPrice` / `refreshTokenPrices` are deliberately not queries: they're one-off event fetches
// (prefill on select, batch price refresh), and queries would explode keys per ticket or break the one-request batch.

export const tokenCatalogueQuery = () =>
  queryOptions({
    queryKey: tokenKeys.catalogue(),
    queryFn: () => listTokenCatalogue(),
    staleTime: STALE_TIME.catalogue,
  });

export const fiatOptionsQuery = (locale: string) =>
  queryOptions({
    queryKey: tokenKeys.fiatOptions(locale),
    queryFn: () => listFiatOptions({ data: { locale } }),
    staleTime: STALE_TIME.catalogue,
  });

export const tokenSearchQuery = (query: string) =>
  queryOptions({
    queryKey: tokenKeys.search(query),
    queryFn: () => listTokens({ data: { query } }),
    staleTime: STALE_TIME.search,
  });

export const tokenEnrichmentQuery = () =>
  queryOptions({
    queryKey: tokenKeys.enrichment(),
    queryFn: async () => readJson(await getTokenEnrichment()),
    staleTime: STALE_TIME.live,
  });
