import type { UpstreamError } from "@folio/upstream-basic";
import {
  hmacSha256,
  makeRequester,
  type Outbound,
  type Requester,
  type SigningFailure,
} from "@folio/upstreams";
import { Clock, Context, Effect, Layer, type Schema } from "effect";
import {
  ACCOUNT_TYPE_FUND,
  ACCOUNT_TYPE_UNIFIED,
  BYBIT_API_BASE,
  EARN_POSITION_PATH,
  FUNDING_BALANCES_PATH,
  HEADER_KEY,
  HEADER_RECV_WINDOW,
  HEADER_SIGN,
  HEADER_SIGN_TYPE,
  HEADER_TIMESTAMP,
  RECV_WINDOW,
  SIGN_TYPE_HMAC,
  WALLET_BALANCE_PATH,
} from "./constants";
import { retCodeError, UPSTREAM } from "./errors";
import {
  type BybitCreds,
  BybitEarnResponse,
  type BybitEnvelope,
  BybitFundingResponse,
  BybitWalletBalanceResponse,
} from "./types";

export interface BybitConfig {
  // Base URL, used as one opaque string (the deployer injects a proxy base when the egress IP is region-blocked by Bybit).
  // The client reads no env and knows nothing of proxies: whoever calls passes it.
  readonly apiBase?: string;
}

// Request layer for Bybit v5: methods follow upstream endpoints and return upstream shapes (DTOs); `parse*`, the locked-segment note copy and the
// `totalPerpUPL` fallback signal are in the adapter. Credentials are passed per call, so one client serves many accounts.
// No gate (quota is per account's own key, so a gate would block nothing; see constants.ts) and no retry of its own.
export interface BybitClientApi {
  // Unified account (UTA). Each token carries `usdValue`, so valuation needs no extra request.
  readonly walletBalance: (
    creds: BybitCreds,
  ) => Effect.Effect<BybitWalletBalanceResponse, UpstreamError, Outbound>;
  // Funding account.
  readonly fundingBalances: (
    creds: BybitCreds,
  ) => Effect.Effect<BybitFundingResponse, UpstreamError, Outbound>;
  // Earn positions. `category` is Bybit's category name (FlexibleSaving / OnChain); which categories to fetch and their labels are the adapter's call.
  readonly earnPositions: (
    creds: BybitCreds,
    category: string,
  ) => Effect.Effect<BybitEarnResponse, UpstreamError, Outbound>;
}

export class BybitClient extends Context.Service<BybitClient, BybitClientApi>()("clients/Bybit") {
  // base may differ per account (proxy override is per-account), so the Layer takes config and the adapter provides it then.
  static readonly layer = (config: BybitConfig = {}): Layer.Layer<BybitClient> =>
    Layer.sync(BybitClient, () => make(config));
}

// Not an Effect: with no gate, construction is pure (like hyperliquid).
export function make(config: BybitConfig = {}): BybitClientApi {
  // Bybit v5 signing: `X-BAPI-SIGN = hex(HMAC-SHA256(secret, timestamp + apiKey + recvWindow + queryString))`.
  // The signed queryString must match what is actually sent byte for byte, so it is rebuilt exactly as `makeRequester` does
  // (`URLSearchParams.set`, skipping undefined); any difference in order, encoding or empty handling breaks the signature,
  // and Bybit answers only retCode 10004, which is painful to debug.
  const signedHeaders = (
    creds: BybitCreds,
    query: Record<string, string>,
  ): Effect.Effect<HeadersInit, SigningFailure> =>
    Effect.gen(function* () {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      // Uses Effect's `Clock` rather than `Date.now()`, so tests can pin it with `TestClock` and assert a deterministic signing string.
      const ts = String(yield* Clock.currentTimeMillis);
      const sign = yield* hmacSha256(
        creds.secret,
        ts + creds.apiKey + RECV_WINDOW + qs.toString(),
        "hex",
      );
      return {
        [HEADER_KEY]: creds.apiKey,
        [HEADER_TIMESTAMP]: ts,
        [HEADER_RECV_WINDOW]: RECV_WINDOW,
        [HEADER_SIGN]: sign,
        [HEADER_SIGN_TYPE]: SIGN_TYPE_HMAC,
      };
    });

  const request: Requester = makeRequester({
    baseUrl: config.apiBase ?? BYBIT_API_BASE,
    upstream: UPSTREAM,
  });

  // Business errors are HTTP 200 + retCode != 0: unchecked, a signature error would read as success with empty `result`, i.e. "this
  // account's balance is 0", silently losing data. Checked in this one `get()` that all endpoints go through, as a visible step rather than a
  // callback field on a core config object.
  const get = <A extends BybitEnvelope, I>(
    path: string,
    schema: Schema.Codec<A, I>,
    query: Record<string, string>,
    creds: BybitCreds,
  ) =>
    request(path, schema, { query, headers: signedHeaders(creds, query) }).pipe(
      Effect.flatMap((body) => {
        const rejected = retCodeError(body, path);
        return rejected ? Effect.fail(rejected) : Effect.succeed(body);
      }),
    );

  return {
    walletBalance: (creds) =>
      get(
        WALLET_BALANCE_PATH,
        BybitWalletBalanceResponse,
        { accountType: ACCOUNT_TYPE_UNIFIED },
        creds,
      ),

    fundingBalances: (creds) =>
      get(FUNDING_BALANCES_PATH, BybitFundingResponse, { accountType: ACCOUNT_TYPE_FUND }, creds),

    earnPositions: (creds, category) =>
      get(EARN_POSITION_PATH, BybitEarnResponse, { category }, creds),
  };
}
