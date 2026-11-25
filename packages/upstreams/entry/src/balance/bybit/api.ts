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
  ACCOUNT_TYPE_FUND,
  ACCOUNT_TYPE_UNIFIED,
  AUTH_ERROR_CODES,
  EARN_POSITION_PATH,
  FUNDING_BALANCES_PATH,
  HEADER_KEY,
  HEADER_RECV_WINDOW,
  HEADER_SIGN,
  HEADER_SIGN_TYPE,
  HEADER_TIMESTAMP,
  ID,
  RECV_WINDOW,
  RET_CODE_OK,
  SIGN_TYPE_HMAC,
  WALLET_BALANCE_PATH,
} from "./constants";

// Only the fields we read. Numbers arrive as strings; `retCode` is a number.

export const BybitCreds = Schema.Struct({ apiKey: Schema.String, secret: Schema.String });
export type BybitCreds = typeof BybitCreds.Type;

const envelope = { retCode: maybe(Schema.Number), retMsg: maybe(Schema.String) };
type BybitEnvelope = { readonly retCode?: number; readonly retMsg?: string };

export const BybitCoin = Schema.Struct({
  coin: maybe(Schema.String),
  walletBalance: maybe(Schema.String), // cash, without futures uPnL: the holdings basis
  usdValue: maybe(Schema.String), // Bybit's own valuation
  locked: maybe(Schema.String), // held by orders / products, included in walletBalance
});
export type BybitCoin = typeof BybitCoin.Type;

const BybitWalletBalanceResponse = Schema.Struct({
  ...envelope,
  result: maybe(
    Schema.Struct({
      list: maybe(
        Schema.Array(
          Schema.Struct({
            totalPerpUPL: maybe(Schema.String), // futures uPnL that walletBalance leaves out
            coin: maybe(Schema.Array(BybitCoin)),
          }),
        ),
      ),
    }),
  ),
});

export const BybitFundingCoin = Schema.Struct({
  coin: maybe(Schema.String),
  walletBalance: maybe(Schema.String),
});
export type BybitFundingCoin = typeof BybitFundingCoin.Type;

const BybitFundingResponse = Schema.Struct({
  ...envelope,
  result: maybe(Schema.Struct({ balance: maybe(Schema.Array(BybitFundingCoin)) })),
});

// The position endpoint has no APR field.
export const BybitEarnPosition = Schema.Struct({
  coin: maybe(Schema.String),
  amount: maybe(Schema.String),
});
export type BybitEarnPosition = typeof BybitEarnPosition.Type;

const BybitEarnResponse = Schema.Struct({
  ...envelope,
  result: maybe(Schema.Struct({ list: maybe(Schema.Array(BybitEarnPosition)) })),
});

// hex(HMAC(secret, timestamp + apiKey + recvWindow + queryString)), the query rebuilt exactly as
// the requester sends it; any difference gets only retCode 10004 back.
const signedHeaders = (creds: BybitCreds, query: Record<string, string>) =>
  Effect.gen(function* () {
    const ts = String(yield* Clock.currentTimeMillis);
    const qs = new URLSearchParams(query).toString();
    const sign = yield* hmacSha256(creds.secret, ts + creds.apiKey + RECV_WINDOW + qs, "hex");
    return {
      [HEADER_KEY]: creds.apiKey,
      [HEADER_TIMESTAMP]: ts,
      [HEADER_RECV_WINDOW]: RECV_WINDOW,
      [HEADER_SIGN]: sign,
      [HEADER_SIGN_TYPE]: SIGN_TYPE_HMAC,
    };
  });

// Unchecked, an error code reads as success with an empty `result`: a zero balance.
const retCodeError = (body: BybitEnvelope, where: string): UpstreamError | undefined => {
  if (body.retCode === RET_CODE_OK) return undefined;
  const code = body.retCode ?? -1;
  // Not `status`: that is the HTTP status.
  const cause = `bybit retCode ${code}: ${body.retMsg || "unknown"}`;
  return AUTH_ERROR_CODES.has(code)
    ? new UpstreamAuthError({ upstream: ID, where, cause })
    : new UpstreamUnavailableError({ upstream: ID, where, cause });
};

const get = <A extends BybitEnvelope, I>(
  call: Call,
  creds: BybitCreds,
  path: string,
  schema: Schema.Codec<A, I>,
  query: Record<string, string>,
) =>
  call.request(path, schema, { query, headers: signedHeaders(creds, query) }).pipe(
    Effect.flatMap((body) => {
      const rejected = retCodeError(body, path);
      return rejected ? Effect.fail(rejected) : Effect.succeed(body);
    }),
  );

export const walletBalance = (call: Call, creds: BybitCreds) =>
  get(call, creds, WALLET_BALANCE_PATH, BybitWalletBalanceResponse, {
    accountType: ACCOUNT_TYPE_UNIFIED,
  });

export const fundingBalances = (call: Call, creds: BybitCreds) =>
  get(call, creds, FUNDING_BALANCES_PATH, BybitFundingResponse, {
    accountType: ACCOUNT_TYPE_FUND,
  });

export const earnPositions = (call: Call, creds: BybitCreds, category: string) =>
  get(call, creds, EARN_POSITION_PATH, BybitEarnResponse, { category });
