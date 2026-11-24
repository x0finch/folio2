// @folio/oracle-basic: contract and data of the token reference layer: types + ports (`*Store` local / `*Upstream` outbound) + constants.
// The one exception is `valuate`, a pure client-safe function used in the client bundle; IO-bearing logic stays in @folio/oracle.
// No data source's name may appear here; the only dependency is `@folio/oracle-ref`, and upstream instances are injected by the app.

export {
  DAILY_FILL_DAYS_PER_CALL,
  DEFAULT_TOP_N,
  dayBucketOf,
  FX_TTL_MS,
  INFO_TTL_MS,
  MS_PER_DAY,
  normalizeSymbol,
  PLATFORM_NEG_TTL_MS,
  PLATFORM_TTL_MS,
  PRICE_TTL_MS,
  RESOLUTION_DOMINANCE,
  RESOLUTION_TOP_RANK,
  TOP_TOKENS_LIMIT,
  WARM_TTL_MS,
} from "./constants";
// Fiat identity: `fiat/issued:<CODE>` recognition and canonical row seed.
export { FIAT_NAMER, fiatCodeOf, fiatSeed } from "./fiat";
// Display currencies + rates (storage is always USD; conversion only in the display layer).
export { type Currency, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from "./fx";
// Platforms (chain + venue) names and logos.
export type { PlatformMeta } from "./platform";
// Opaque form of a tokenRef handed to the browser (token picker).
export { tokenTicket } from "./ticket";
export type {
  ProviderTokenSeed,
  TokenCandidate,
  TokenInfo,
  TokenInfoPatch,
  TokenInfoWrite,
  TokenPrice,
  TokenPricePoint,
  TokenPriceWrite,
  TokenRecord,
  TokenRecordPrice,
  TokenRef,
  TokenRefHit,
  TokenRefIndexRow,
} from "./types";
export type {
  FxUpstream,
  PlatformUpstream,
  PriceUpstream,
  RefIndexFetch,
  TokenMetaUpstream,
  TokenRefIndexUpstream,
  TokenUpstream,
  UpstreamToken,
} from "./upstream";
// Valuation priority pure function + modes. Client-safe, hence here rather than entry.
export { type ValuationMode, valuate } from "./valuate";
