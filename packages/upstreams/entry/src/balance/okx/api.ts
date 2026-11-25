import {
  UpstreamAuthError,
  type UpstreamError,
  UpstreamUnavailableError,
} from "@folio/upstream-basic";
import { Clock, Effect, Schema } from "effect";
import { hmacSha256 } from "../../runtime/crypto";
import type { Call } from "../../runtime/define";
import { maybe } from "../../runtime/schema";
import {
  ASSET_VALUATION_PATH,
  AUTH_ERROR_CODES,
  BALANCE_PATH,
  CODE_OK,
  FUNDING_BALANCES_PATH,
  HEADER_KEY,
  HEADER_PASSPHRASE,
  HEADER_SIGN,
  HEADER_TIMESTAMP,
  ID,
  POSITIONS_PATH,
  SAVINGS_BALANCE_PATH,
  STAKING_ORDERS_ACTIVE_PATH,
  VALUATION_QUERY,
} from "./constants";

// Only the fields we read. Numbers arrive as strings, and so does `code`.

export const OkxCreds = Schema.Struct({
  apiKey: Schema.String,
  secret: Schema.String,
  passphrase: Schema.String,
});
export type OkxCreds = typeof OkxCreds.Type;

const envelope = { code: maybe(Schema.String), msg: maybe(Schema.String) };
type OkxEnvelope = { readonly code?: string; readonly msg?: string };

export const OkxDetail = Schema.Struct({
  ccy: maybe(Schema.String),
  eq: maybe(Schema.String), // includes margin uPnL: only for the implied price, not the amount
  eqUsd: maybe(Schema.String), // eqUsd / eq = market price
  cashBal: maybe(Schema.String), // the holdings basis
  frozenBal: maybe(Schema.String), // held by orders / borrowing
});
export type OkxDetail = typeof OkxDetail.Type;

const OkxBalanceResponse = Schema.Struct({
  ...envelope,
  data: maybe(Schema.Array(Schema.Struct({ details: maybe(Schema.Array(OkxDetail)) }))),
});

export const OkxFundingAsset = Schema.Struct({
  ccy: maybe(Schema.String),
  bal: maybe(Schema.String), // includes frozen
});
export type OkxFundingAsset = typeof OkxFundingAsset.Type;

const OkxFundingResponse = Schema.Struct({
  ...envelope,
  data: maybe(Schema.Array(OkxFundingAsset)),
});

export const OkxSavingsRow = Schema.Struct({
  ccy: maybe(Schema.String),
  amt: maybe(Schema.String),
  rate: maybe(Schema.String), // APY as a fraction
});
export type OkxSavingsRow = typeof OkxSavingsRow.Type;

const OkxSavingsResponse = Schema.Struct({ ...envelope, data: maybe(Schema.Array(OkxSavingsRow)) });

export const OkxStakingOrder = Schema.Struct({
  ccy: maybe(Schema.String),
  protocol: maybe(Schema.String),
  apy: maybe(Schema.String), // fraction
  investData: maybe(
    Schema.Array(Schema.Struct({ ccy: maybe(Schema.String), amt: maybe(Schema.String) })),
  ),
});
export type OkxStakingOrder = typeof OkxStakingOrder.Type;

const OkxStakingResponse = Schema.Struct({
  ...envelope,
  data: maybe(Schema.Array(OkxStakingOrder)),
});

export const OkxValuationResponse = Schema.Struct({
  ...envelope,
  data: maybe(
    Schema.Array(
      Schema.Struct({
        totalBal: maybe(Schema.String),
        details: maybe(
          Schema.Struct({
            classic: maybe(Schema.String),
            earn: maybe(Schema.String),
            funding: maybe(Schema.String),
            trading: maybe(Schema.String),
          }),
        ),
      }),
    ),
  ),
});
export type OkxValuationResponse = typeof OkxValuationResponse.Type;

export const OkxPositionsResponse = Schema.Struct({
  ...envelope,
  data: maybe(
    Schema.Array(
      Schema.Struct({
        instId: maybe(Schema.String),
        pos: maybe(Schema.String),
        upl: maybe(Schema.String),
      }),
    ),
  ),
});
export type OkxPositionsResponse = typeof OkxPositionsResponse.Type;

// base64(HMAC(secret, isoTimestamp + "GET" + requestPath)), where requestPath includes the query
// rebuilt exactly as the requester sends it; a mismatch is code 50113.
const signedHeaders = (creds: OkxCreds, path: string, query: Record<string, string>) =>
  Effect.gen(function* () {
    const qs = new URLSearchParams(query).toString();
    const ts = new Date(yield* Clock.currentTimeMillis).toISOString();
    const sign = yield* hmacSha256(
      creds.secret,
      `${ts}GET${qs ? `${path}?${qs}` : path}`,
      "base64",
    );
    return {
      [HEADER_KEY]: creds.apiKey,
      [HEADER_SIGN]: sign,
      [HEADER_TIMESTAMP]: ts,
      [HEADER_PASSPHRASE]: creds.passphrase,
    };
  });

// Unchecked, an error code reads as success with empty `data`: a zero balance.
const codeError = (body: OkxEnvelope, where: string): UpstreamError | undefined => {
  if (body.code === CODE_OK) return undefined;
  const code = body.code ?? "?";
  // Not `status`: that is the HTTP status.
  const cause = `okx code ${code}: ${body.msg || "unknown"}`;
  return AUTH_ERROR_CODES.has(code)
    ? new UpstreamAuthError({ upstream: ID, where, cause })
    : new UpstreamUnavailableError({ upstream: ID, where, cause });
};

const get = <A extends OkxEnvelope, I>(
  call: Call,
  creds: OkxCreds,
  path: string,
  schema: Schema.Codec<A, I>,
  query: Record<string, string> = {},
) =>
  call.request(path, schema, { query, headers: signedHeaders(creds, path, query) }).pipe(
    Effect.flatMap((body) => {
      const rejected = codeError(body, path);
      return rejected ? Effect.fail(rejected) : Effect.succeed(body);
    }),
  );

export const balance = (call: Call, creds: OkxCreds) =>
  get(call, creds, BALANCE_PATH, OkxBalanceResponse);

export const fundingBalances = (call: Call, creds: OkxCreds) =>
  get(call, creds, FUNDING_BALANCES_PATH, OkxFundingResponse);

export const savingsBalance = (call: Call, creds: OkxCreds) =>
  get(call, creds, SAVINGS_BALANCE_PATH, OkxSavingsResponse);

export const stakingOrders = (call: Call, creds: OkxCreds) =>
  get(call, creds, STAKING_ORDERS_ACTIVE_PATH, OkxStakingResponse);

export const assetValuation = (call: Call, creds: OkxCreds) =>
  get(call, creds, ASSET_VALUATION_PATH, OkxValuationResponse, VALUATION_QUERY);

export const positions = (call: Call, creds: OkxCreds) =>
  get(call, creds, POSITIONS_PATH, OkxPositionsResponse);
