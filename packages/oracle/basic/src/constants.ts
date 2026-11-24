// Stable domain constants of the reference layer; no data source's values (`OVERRIDES` belongs to the adapter).

// Symbol disambiguation gate
export const RESOLUTION_TOP_RANK = 50; // within market-cap top-N is trusted (high confidence)
export const RESOLUTION_DOMINANCE = 5; // the best must beat the runner-up by this rank ratio to be high confidence

// Cache TTLs
// The warm blob is the catalogue (symbol/name/logo/rank), nearly static, so its TTL follows the catalogue, not prices: this value
// is how often the background warm refreshes it. Only top-1000 entrants and rank change, and rank feeds two coarse gates.
// The write path (mint) never looks at it: it uses what exists however old (see `warmCatalogue`).
export const WARM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d (catalogue, near-static)
export const PRICE_TTL_MS = 30 * 60 * 1000; // 30min (long-tail prices; expired means stale, not deleted: SWR)
// name/logo are near-static; decoupled from the short warm/price TTLs, or the display would lose logo/name when warm expires.
export const INFO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
// Fx rates are not prices: fiats move parts per thousand a day, so they do not share the 30min long-tail price TTL; a short TTL
// would only make warm refresh twelve more times, and reads soft-expire anyway.
export const FX_TTL_MS = 6 * 60 * 60 * 1000; // 6h (fiat rates, slow-moving)
export const PLATFORM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d (chain/venue names and logos, near-static)
// Negative-cache TTL (asked upstream, no such key): much shorter, since a new chain can be listed anytime, and remembering "none"
// only exists to stop every warm refetching the whole chain table for this key.
export const PLATFORM_NEG_TTL_MS = 24 * 60 * 60 * 1000; // 1d

// Warm depth (top-N markets) and default picker list size.
export const DEFAULT_TOP_N = 1000;
export const TOP_TOKENS_LIMIT = 50;

// Historical price day buckets
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const dayBucketOf = (ms: number): number => Math.floor(ms / MS_PER_DAY);
// Days one range request of the daily-price backfill covers at most: a year, so three years is 3-4 requests, and for ranges
// over three months upstream gives daily points (short ranges give hourly points, thousands per request and wasted parse CPU).
export const DAILY_FILL_DAYS_PER_CALL = 365;

// Key normalisation: the store only stores / looks up by key; normalisation is always done by the caller (here).
export const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase();
