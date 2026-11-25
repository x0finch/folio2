import { UpstreamAuthError, type UpstreamError } from "@folio/upstream-basic";
import { Clock, Effect, Schema } from "effect";
import { hmacSha256 } from "../../runtime/crypto";
import type { Call } from "../../runtime/define";
import type { Outbound, Requester } from "../../runtime/http";
import { maybe } from "../../runtime/schema";
import {
  ACCOUNT_PATH,
  API_KEY_HEADER,
  COINM_ACCOUNT_PATH,
  DELIVERY_HOST,
  EARN_FLEXIBLE_PATH,
  EARN_LOCKED_PATH,
  EARN_MAX_PAGES,
  EARN_PAGE_SIZE,
  FUNDING_ASSET_PATH,
  FUTURES_HOST,
  ID,
  RECV_WINDOW,
  SIGNED_REQUEST_REJECTED_STATUS,
  TICKER_LIMIT,
  TICKER_PRICE_PATH,
  USDM_ACCOUNT_PATH,
} from "./constants";

// Only the fields we read. Numbers arrive as strings.

export const BinanceCreds = Schema.Struct({ apiKey: Schema.String, secret: Schema.String });
export type BinanceCreds = typeof BinanceCreds.Type;

const TickerPrice = Schema.Struct({ symbol: maybe(Schema.String), price: maybe(Schema.String) });

const SpotAccount = Schema.Struct({
  balances: maybe(
    Schema.Array(
      Schema.Struct({
        asset: maybe(Schema.String),
        free: maybe(Schema.String),
        locked: maybe(Schema.String),
      }),
    ),
  ),
});
export type SpotAccount = typeof SpotAccount.Type;

const FuturesAccount = Schema.Struct({
  totalMarginBalance: maybe(Schema.String), // wallet balance + unrealized PnL
  totalPositionInitialMargin: maybe(Schema.String),
  maxWithdrawAmount: maybe(Schema.String),
  positions: maybe(
    Schema.Array(
      Schema.Struct({
        symbol: maybe(Schema.String),
        positionAmt: maybe(Schema.String),
        entryPrice: maybe(Schema.String),
        unrealizedProfit: maybe(Schema.String),
        leverage: maybe(Schema.String),
        notional: maybe(Schema.String),
        isolated: maybe(Schema.Boolean),
        positionInitialMargin: maybe(Schema.String),
      }),
    ),
  ),
});
export type FuturesAccount = typeof FuturesAccount.Type;

// Every figure is in the coin, not USD; positions count contracts.
const CoinmAccount = Schema.Struct({
  assets: maybe(
    Schema.Array(
      Schema.Struct({
        asset: maybe(Schema.String),
        marginBalance: maybe(Schema.String),
        maxWithdrawAmount: maybe(Schema.String),
        positionInitialMargin: maybe(Schema.String),
      }),
    ),
  ),
  positions: maybe(
    Schema.Array(
      Schema.Struct({
        symbol: maybe(Schema.String),
        positionAmt: maybe(Schema.String),
        entryPrice: maybe(Schema.String),
        unrealizedProfit: maybe(Schema.String),
        leverage: maybe(Schema.String),
        notional: maybe(Schema.String),
        isolated: maybe(Schema.Boolean),
        positionInitialMargin: maybe(Schema.String),
      }),
    ),
  ),
});
export type CoinmAccount = typeof CoinmAccount.Type;

const FundingAsset = Schema.Struct({
  asset: maybe(Schema.String),
  free: maybe(Schema.String),
  locked: maybe(Schema.String),
  freeze: maybe(Schema.String),
  withdrawing: maybe(Schema.String),
});
export type FundingAsset = typeof FundingAsset.Type;

const EarnFlexibleRow = Schema.Struct({
  asset: maybe(Schema.String),
  totalAmount: maybe(Schema.String),
  latestAnnualPercentageRate: maybe(Schema.String), // fraction
});
export type EarnFlexibleRow = typeof EarnFlexibleRow.Type;

const EarnLockedRow = Schema.Struct({
  asset: maybe(Schema.String),
  amount: maybe(Schema.String),
  apy: maybe(Schema.String), // fraction
  redeemDate: maybe(Schema.Union([Schema.Number, Schema.String])), // ms epoch
});
export type EarnLockedRow = typeof EarnLockedRow.Type;

const EarnPage = <A, I>(row: Schema.Codec<A, I>) =>
  Schema.Struct({
    rows: maybe(Schema.Array(row)),
    total: maybe(Schema.Union([Schema.Number, Schema.String])),
  });

// Binance answers a rejected signed request with 400; retrying re-sends bad creds, which it treats
// as probing. Its rare other 400s (-1021 clock skew) aren't transient either.
const rejectedSignatureIsAuth = <A, R>(
  effect: Effect.Effect<A, UpstreamError, R>,
): Effect.Effect<A, UpstreamError, R> =>
  Effect.catchTag(effect, "UpstreamRefusedError", (failure) =>
    Effect.fail(
      failure.status === SIGNED_REQUEST_REJECTED_STATUS
        ? new UpstreamAuthError({
            upstream: ID,
            where: failure.where,
            status: failure.status,
            cause: failure.cause,
          })
        : failure,
    ),
  );

// The signature covers the query in send order and goes last; a mismatch is a 400 (-1022).
const signed = <A, I>(
  requester: Requester,
  creds: BinanceCreds,
  path: string,
  schema: Schema.Codec<A, I>,
  params: Record<string, string | number> = {},
  method: "GET" | "POST" = "GET",
) =>
  Effect.gen(function* () {
    const signable = {
      ...params,
      recvWindow: RECV_WINDOW,
      timestamp: yield* Clock.currentTimeMillis,
    };
    const query = Object.fromEntries(Object.entries(signable).map(([k, v]) => [k, String(v)]));
    const signature = yield* hmacSha256(creds.secret, new URLSearchParams(query).toString(), "hex");
    return yield* requester(path, schema, {
      query: { ...query, signature },
      headers: Effect.succeed({ [API_KEY_HEADER]: creds.apiKey }),
      method,
    });
  }).pipe(
    // Signing happens before the requester, so its failure isn't classified there.
    Effect.catchTag("SigningFailure", (e) =>
      Effect.fail(new UpstreamAuthError({ upstream: ID, where: e.where, cause: e.cause })),
    ),
    rejectedSignatureIsAuth,
  );

// symbol → price, under the ticker gate.
export const tickerPrices = (call: Call) =>
  call
    .via(TICKER_LIMIT)(TICKER_PRICE_PATH, Schema.NullOr(Schema.Array(TickerPrice)))
    .pipe(
      rejectedSignatureIsAuth,
      Effect.map((raw) => {
        const prices: Record<string, number> = {};
        for (const t of raw ?? []) {
          if (t.symbol) prices[t.symbol] = Number(t.price ?? 0);
        }
        return prices;
      }),
    );

export const spotAccount = (call: Call, creds: BinanceCreds) =>
  signed(call.request, creds, ACCOUNT_PATH, SpotAccount);

export const usdmAccount = (call: Call, creds: BinanceCreds) =>
  signed(call.host(FUTURES_HOST), creds, USDM_ACCOUNT_PATH, FuturesAccount);

export const coinmAccount = (call: Call, creds: BinanceCreds) =>
  signed(call.host(DELIVERY_HOST), creds, COINM_ACCOUNT_PATH, CoinmAccount);

// Params still go in the query.
export const fundingAssets = (call: Call, creds: BinanceCreds) =>
  signed(call.request, creds, FUNDING_ASSET_PATH, Schema.Array(FundingAsset), {}, "POST");

// Pages until a short page or `total`; the first page alone holds only 10 rows by default.
const earnRows = <Row, I>(
  call: Call,
  creds: BinanceCreds,
  path: string,
  row: Schema.Codec<Row, I>,
): Effect.Effect<Row[], UpstreamError, Outbound> =>
  Effect.gen(function* () {
    const page$ = EarnPage(row);
    const rows: Row[] = [];
    for (let current = 1; current <= EARN_MAX_PAGES; current++) {
      const page = yield* signed(call.request, creds, path, page$, {
        current,
        size: EARN_PAGE_SIZE,
      });
      const batch = page.rows ?? [];
      rows.push(...batch);
      if (batch.length < EARN_PAGE_SIZE) break;
      const total = Number(page.total ?? 0);
      if (total > 0 && rows.length >= total) break;
    }
    return rows;
  });

export const earnFlexible = (call: Call, creds: BinanceCreds) =>
  earnRows(call, creds, EARN_FLEXIBLE_PATH, EarnFlexibleRow);

export const earnLocked = (call: Call, creds: BinanceCreds) =>
  earnRows(call, creds, EARN_LOCKED_PATH, EarnLockedRow);
