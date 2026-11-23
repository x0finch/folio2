// Rabby (a DeBank backend) API constants. Only what the request layer needs: `DUST_USD` (display filter) and `EVM_ADDRESS_RE` (accountCreds validation) belong to the adapter.

// Who this is: goes into every error's `upstream` field.
export const UPSTREAM = "rabby";

export const RABBY_API_BASE = "https://api.rabby.io";
export const CHAIN_LIST_PATH = "/v1/chain/list";
export const CACHE_TOKEN_LIST_PATH = "/v1/user/cache_token_list";
export const COMPLEX_PROTOCOL_LIST_PATH = "/v1/user/complex_protocol_list";
export const TOTAL_BALANCE_PATH = "/v1/user/total_balance"; // the lightest endpoint, for liveness probes
export const CHAINS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Client identifier in the signing header: part of the signature computation, do not change.
export const RABBY_CLIENT = "Rabby";
export const RABBY_CLIENT_VERSION = "0.93.49";

// Rate gate
// Rabby throttles instantaneous concurrency, not total volume. Measured (signed requests, one IP): 150 serial requests gave zero 429s, but
// 20 concurrent dropped 5, and a second round of 14 concurrent dropped 12, recovering slowly. Sync concurrency is 6 with 2-3 requests per
// account, so real instantaneous concurrency is ~12, right at the edge.
// The policy is "never hit it", not "retry after hitting": the retry backoff caps at 5s while rabby recovers slower, so three retries
// would likely all be wasted. Hence limit=1, no bursts: requests spread to 8/s, at the cost of 125ms for an account's second request.
// Rabby's 429 carries no Retry-After (measured), so backoff is a blind guess, all the more reason to rely on the gate.
export const MAX_REQUESTS_PER_SECOND = 8;

// Gate key: rabby's quota follows the signature (measured), not the egress IP, shared by all accounts, so one global gate rather than one per account.
export const RATE_LIMIT_KEY = "rabby:signed";
