// CoinGecko API constants.

// Transport
export const CG_BASE_FREE = "https://api.coingecko.com/api/v3";
export const CG_BASE_PRO = "https://pro-api.coingecko.com/api/v3";
export const HEADER_DEMO = "x-cg-demo-api-key";
export const HEADER_PRO = "x-cg-pro-api-key";
// Deliberately neutral: no project name, no repo address (requests go to a third party, and the Trezor/blockbook one carries an xpub);
// a UA naming the project would tie "who is watching" to a person and group self-hosted instances.
// It cannot simply be omitted: Workers' fetch sends none and CGK's Cloudflare WAF answers 403, so send the most common unspecific value.
export const USER_AGENT = "Mozilla/5.0";

// Rate numbers: each states its source; a guessed number left untraced is worse than none (too tight is slow for search / picker, too loose is no gate).

// Gate key: the env var name, never the key's value (it goes into log attributes); CGK's quota is per key, so a stable identifier stands for "that key".
// One key is shared across the deployment: every user's call spends the same quota.
export const CG_LIMIT_KEY = "COINGECKO_API_KEY";
export const CG_LIMIT_KEY_KEYLESS = "coingecko:keyless"; // without a key quota is per egress IP, a separate quota

// Quota
// Official docs (https://docs.coingecko.com/docs/common-errors-rate-limit): Demo (free key) 100 calls/min; no key is limited per IP
// and shared by all keyless users (no number given); paid tiers vary. 4xx / 5xx also count toward quota, so each tier leaves headroom.
export const CG_CALLS_PER_MIN_DEMO = 80; // nominal 100, 20% left for error responses and window edges
export const CG_CALLS_PER_MIN_KEYLESS = 10; // docs give no number: conservative, not measured; adjust on hitting it
export const CG_CALLS_PER_MIN_PRO = 400; // docs say only "varies": a clearly conservative value; tune to your own plan

// Burst capacity is 2, not 4: catalogue warm walks 4 pages while search and the picker fire on user input from the same bucket; a large
// capacity lets warm drain the burst and stall the next search, while the cost of 2 is a few seconds slower warm in the background.
// This is also why fetchMarkets stays sequential: concurrency only drains burst faster and makes the foreground wait longer.
export const CG_BURST = 2;

// Retry: the retry policy and its constants live with the caller (`@folio/oracle-upstream-coingecko`); this client has none.

// Who this is: goes into every error's `upstream` field.
export const UPSTREAM = "coingecko";
