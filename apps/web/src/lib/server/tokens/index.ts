import { createServerFn } from "@tanstack/react-start";
import { runEffect, runEffectJson } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleListTokenCatalogue } from "./catalogue";
import { handleGetTokenEnrichment } from "./enrichment";
import { handleListTokens, ListTokensInput } from "./list";
import { handleListFiatOptions, ListFiatOptionsInput } from "./list-fiat-options";
import { handleGetTokenPrice, TokenPriceInput } from "./price";
import { handleRefreshTokenPrices, RefreshTokenPricesInput } from "./refresh-prices";

// Picker server fns, assembly only. Read endpoints don't create rows (the token row is minted on form submit), so
// they hand out an opaque ticket (base64url tokenRef) the client passes through unchanged (see `TokenOption`).

export const listTokenCatalogue = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleListTokenCatalogue));

export const getTokenEnrichment = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffectJson(handleGetTokenEnrichment));

// requireAuth like the other picker endpoints.
export const listFiatOptions = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(ListFiatOptionsInput)
  .handler(runEffect(handleListFiatOptions));

export const listTokens = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(ListTokensInput)
  .handler(runEffect(handleListTokens));

export const getTokenPrice = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(TokenPriceInput)
  .handler(runEffect(handleGetTokenPrice));

export const refreshTokenPrices = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RefreshTokenPricesInput)
  .handler(runEffect(handleRefreshTokenPrices));
