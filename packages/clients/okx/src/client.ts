import {
  hmacSha256,
  makeRequester,
  type Outbound,
  type Requester,
  type SigningFailure,
  type UpstreamError,
} from "@folio/client-core";
import { Clock, Context, Effect, Layer, type Schema } from "effect";
import {
  ASSET_VALUATION_PATH,
  BALANCE_PATH,
  FUNDING_BALANCES_PATH,
  HEADER_KEY,
  HEADER_PASSPHRASE,
  HEADER_SIGN,
  HEADER_TIMESTAMP,
  OKX_API_BASE,
  POSITIONS_PATH,
  SAVINGS_BALANCE_PATH,
  STAKING_ORDERS_ACTIVE_PATH,
  VALUATION_CCY,
} from "./constants";
import { codeError, UPSTREAM } from "./errors";
import {
  OkxBalanceResponse,
  type OkxCreds,
  type OkxEnvelope,
  OkxFundingResponse,
  OkxPositionsResponse,
  OkxSavingsResponse,
  OkxStakingResponse,
  OkxValuationResponse,
} from "./types";

export interface OkxConfig {
  // Base URL, used as one opaque string (the deployer injects a proxy base when the egress IP is region-blocked).
  readonly apiBase?: string;
}

// Request layer for OKX v5: methods follow upstream endpoints and return upstream shapes (DTOs); `parseBalances`, the price hint
// table (eqUsd/eq), earn residual rows and freeze note copy are in the adapter.
// Credentials are passed per call (apiKey / secret / passphrase, the last of which binance and Bybit lack). No gate (see constants.ts), no retry of its own.
export interface OkxClientApi {
  // Trading account. Each token carries `eqUsd`, so valuation needs no extra request (and eqUsd/eq doubles as a price hint for other buckets).
  readonly balance: (creds: OkxCreds) => Effect.Effect<OkxBalanceResponse, UpstreamError, Outbound>;
  // Funding account.
  readonly fundingBalances: (
    creds: OkxCreds,
  ) => Effect.Effect<OkxFundingResponse, UpstreamError, Outbound>;
  // Earn: flexible lending.
  readonly savingsBalance: (
    creds: OkxCreds,
  ) => Effect.Effect<OkxSavingsResponse, UpstreamError, Outbound>;
  // Earn: active on-chain orders.
  readonly stakingOrders: (
    creds: OkxCreds,
  ) => Effect.Effect<OkxStakingResponse, UpstreamError, Outbound>;
  // Authoritative USD amount per bucket (trading / funding / earn / classic).
  readonly assetValuation: (
    creds: OkxCreds,
  ) => Effect.Effect<OkxValuationResponse, UpstreamError, Outbound>;
  // Contract positions.
  readonly positions: (
    creds: OkxCreds,
  ) => Effect.Effect<OkxPositionsResponse, UpstreamError, Outbound>;
}

export class OkxClient extends Context.Tag("clients/Okx")<OkxClient, OkxClientApi>() {
  // base may differ per account (proxy override is per-account), so the Layer takes config.
  static readonly layer = (config: OkxConfig = {}): Layer.Layer<OkxClient> =>
    Layer.sync(OkxClient, () => make(config));
}

// Not an Effect: with no gate, construction is pure (like hyperliquid / bybit).
export function make(config: OkxConfig = {}): OkxClientApi {
  // OKX v5 signing: `OK-ACCESS-SIGN = base64(HMAC-SHA256(secret, timestamp + "GET" + requestPath))`.
  // `requestPath` includes the query, the easiest thing to sign wrong here: the query goes through `options.query` as usual and the signing
  // step rebuilds it into requestPath exactly as `makeRequester` does (`URLSearchParams.set`, skipping undefined); any mismatch gets OKX's 50113.
  // The timestamp is an ISO string, not milliseconds (differs from binance / Bybit).
  const signedHeaders = (
    path: string,
    creds: OkxCreds,
    query: Record<string, string> | undefined,
  ): Effect.Effect<HeadersInit, SigningFailure> =>
    Effect.gen(function* () {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query ?? {})) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const requestPath = qs.size > 0 ? `${path}?${qs.toString()}` : path;
      // Uses Effect's `Clock` rather than `new Date()`, so tests can pin it with `TestClock` and assert a deterministic signing string.
      const ts = new Date(yield* Clock.currentTimeMillis).toISOString();
      const sign = yield* hmacSha256(creds.secret, `${ts}GET${requestPath}`, "base64");
      return {
        [HEADER_KEY]: creds.apiKey,
        [HEADER_SIGN]: sign,
        [HEADER_TIMESTAMP]: ts,
        [HEADER_PASSPHRASE]: creds.passphrase,
        "Content-Type": "application/json",
      };
    });

  const request: Requester = makeRequester({
    baseUrl: config.apiBase ?? OKX_API_BASE,
    upstream: UPSTREAM,
  });

  // Business errors are HTTP 200 + code != "0" (a string): unchecked, a signature error would read as success with empty `data`, i.e. "this
  // account's balance is 0", silently losing data. Checked in this one `get()` that all six endpoints go through, as a visible step rather than a
  // callback field on a core config object.
  const get = <A extends OkxEnvelope, I>(
    path: string,
    schema: Schema.Schema<A, I>,
    creds: OkxCreds,
    query?: Record<string, string>,
  ) =>
    request(path, schema, { query, headers: signedHeaders(path, creds, query) }).pipe(
      Effect.flatMap((body) => {
        const rejected = codeError(body, path);
        return rejected ? Effect.fail(rejected) : Effect.succeed(body);
      }),
    );

  return {
    balance: (creds) => get(BALANCE_PATH, OkxBalanceResponse, creds),
    fundingBalances: (creds) => get(FUNDING_BALANCES_PATH, OkxFundingResponse, creds),
    savingsBalance: (creds) => get(SAVINGS_BALANCE_PATH, OkxSavingsResponse, creds),
    stakingOrders: (creds) => get(STAKING_ORDERS_ACTIVE_PATH, OkxStakingResponse, creds),
    assetValuation: (creds) =>
      get(ASSET_VALUATION_PATH, OkxValuationResponse, creds, { ccy: VALUATION_CCY }),
    positions: (creds) => get(POSITIONS_PATH, OkxPositionsResponse, creds),
  };
}
