import {
  hmacSha256,
  makeRateLimit,
  makeRequester,
  type Outbound,
  type Requester,
  UpstreamAuthError,
  type UpstreamError,
} from "@folio/client-core";
import { Clock, Context, Duration, Effect, Layer, Schema, type Scope } from "effect";
import {
  ACCOUNT_PATH,
  API_KEY_HEADER,
  BINANCE_API_BASE,
  BINANCE_DELIVERY_API_BASE,
  BINANCE_FUTURES_API_BASE,
  COINM_ACCOUNT_PATH,
  EARN_FLEXIBLE_PATH,
  EARN_LOCKED_PATH,
  EARN_MAX_PAGES,
  EARN_PAGE_SIZE,
  FUNDING_ASSET_PATH,
  PUBLIC_LIMIT_KEY,
  RATE_LIMITED_STATUSES,
  RECV_WINDOW,
  TICKER_PRICE_PATH,
  TICKER_RATE_LIMIT_BURST,
  TICKER_RATE_LIMIT_PER_SEC,
  USDM_ACCOUNT_PATH,
} from "./constants";
import { rejectedSignatureIsAuth, UPSTREAM } from "./errors";
import {
  type BinanceCreds,
  CoinmAccount,
  EarnFlexibleRow,
  EarnLockedRow,
  EarnPage,
  FundingAsset,
  FuturesAccount,
  SpotAccount,
  TickerPrice,
} from "./types";

export interface BinanceConfig {
  // Opaque per-host bases (a deployment may inject a proxy when the egress IP is geo-blocked).
  // The client never reads env; omitted means the official host.
  readonly apiBase?: string;
  readonly fapiBase?: string;
  readonly dapiBase?: string;
}

// Binance REST client: returns upstream DTOs. Creds are passed per call (one client, many
// accounts). No built-in retry — callers wrap with `Effect.retry`.
export interface BinanceClientApi {
  // symbol → price. The only gated endpoint (public, metered per egress IP).
  readonly tickerPrices: Effect.Effect<Record<string, number>, UpstreamError, Outbound>;
  readonly spotAccount: (
    creds: BinanceCreds,
  ) => Effect.Effect<SpotAccount, UpstreamError, Outbound>;
  readonly usdmAccount: (
    creds: BinanceCreds,
  ) => Effect.Effect<FuturesAccount, UpstreamError, Outbound>;
  readonly coinmAccount: (
    creds: BinanceCreds,
  ) => Effect.Effect<CoinmAccount, UpstreamError, Outbound>;
  readonly fundingAssets: (
    creds: BinanceCreds,
  ) => Effect.Effect<readonly FundingAsset[], UpstreamError, Outbound>;
  // Earn endpoints paginate internally and return all rows.
  readonly earnFlexible: (
    creds: BinanceCreds,
  ) => Effect.Effect<EarnFlexibleRow[], UpstreamError, Outbound>;
  readonly earnLocked: (
    creds: BinanceCreds,
  ) => Effect.Effect<EarnLockedRow[], UpstreamError, Outbound>;
}

export class BinanceClient extends Context.Service<BinanceClient, BinanceClientApi>()(
  "clients/Binance",
) {
  // Bases can differ per account, so the layer takes config. Rebuilding it doesn't reset quota:
  // the `isolated` cursor is module-level.
  static readonly layer = (config: BinanceConfig = {}): Layer.Layer<BinanceClient> =>
    Layer.effect(BinanceClient, make(config));
}

export function make(
  config: BinanceConfig = {},
): Effect.Effect<BinanceClientApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const publicLimit = yield* makeRateLimit({
      key: PUBLIC_LIMIT_KEY,
      limit: TICKER_RATE_LIMIT_BURST,
      interval: Duration.millis((TICKER_RATE_LIMIT_BURST / TICKER_RATE_LIMIT_PER_SEC) * 1000),
    });

    const publicRequester = makeRequester({
      baseUrl: config.apiBase ?? BINANCE_API_BASE,
      upstream: UPSTREAM,
      limit: publicLimit,
      rateLimitedStatuses: RATE_LIMITED_STATUSES,
    });

    // Signed endpoints are deliberately ungated: one non-concurrent call per account, so a gate
    // would only queue unrelated accounts behind each other.
    const signedRequester = (baseUrl: string): Requester =>
      makeRequester({
        baseUrl,
        upstream: UPSTREAM,
        rateLimitedStatuses: RATE_LIMITED_STATUSES,
      });

    const spot = signedRequester(config.apiBase ?? BINANCE_API_BASE);
    const fapi = signedRequester(config.fapiBase ?? BINANCE_FUTURES_API_BASE);
    const dapi = signedRequester(config.dapiBase ?? BINANCE_DELIVERY_API_BASE);

    // Binance signs the query in send order (minus `signature`), so sign the same params object
    // and append `signature` last; a mismatch is a 400 (-1022). Timestamp via `Clock` for TestClock.
    const signedGet = <A, I>(
      requester: Requester,
      path: string,
      schema: Schema.Codec<A, I>,
      params: Record<string, string | number>,
      creds: BinanceCreds,
      method: "GET" | "POST" = "GET", // funding is a signed POST; params still go in the query
    ): Effect.Effect<A, UpstreamError, Outbound> =>
      Effect.gen(function* () {
        const timestamp = yield* Clock.currentTimeMillis;
        const signable = { ...params, recvWindow: RECV_WINDOW, timestamp };
        const signature = yield* hmacSha256(
          creds.secret,
          new URLSearchParams(signable as never).toString(),
          "hex",
        );
        return yield* requester(path, schema, {
          query: { ...signable, signature },
          headers: Effect.succeed({ [API_KEY_HEADER]: creds.apiKey }),
          method,
        });
      }).pipe(
        // The signature goes in the query, not a header, so the requester never sees this failure.
        // Only an invalid secret gets here: an auth problem, not retryable.
        Effect.catchTag("SigningFailure", (e) =>
          Effect.fail(
            new UpstreamAuthError({ upstream: UPSTREAM, where: e.where, cause: e.cause }),
          ),
        ),
        rejectedSignatureIsAuth,
      );

    // Page until a short page or `total` is reached; the first page alone holds only 10 rows.
    const earnRows = <Row, I>(
      path: string,
      row: Schema.Codec<Row, I>,
      creds: BinanceCreds,
    ): Effect.Effect<Row[], UpstreamError, Outbound> =>
      Effect.gen(function* () {
        const page$ = EarnPage(row);
        const rows: Row[] = [];
        for (let current = 1; current <= EARN_MAX_PAGES; current++) {
          const page = yield* signedGet(
            spot,
            path,
            page$,
            { current, size: EARN_PAGE_SIZE },
            creds,
          );
          const batch = page.rows ?? [];
          rows.push(...batch);
          if (batch.length < EARN_PAGE_SIZE) break; // short page = last page
          const total = Number(page.total ?? 0);
          if (total > 0 && rows.length >= total) break;
        }
        return rows;
      });

    return {
      tickerPrices: publicRequester(
        TICKER_PRICE_PATH,
        Schema.NullOr(Schema.Array(TickerPrice)),
      ).pipe(
        rejectedSignatureIsAuth,
        Effect.map((raw) => {
          const map: Record<string, number> = {};
          for (const t of raw ?? []) {
            if (t.symbol) map[t.symbol] = Number(t.price ?? 0);
          }
          return map;
        }),
      ),

      spotAccount: (creds) => signedGet(spot, ACCOUNT_PATH, SpotAccount, {}, creds),

      usdmAccount: (creds) => signedGet(fapi, USDM_ACCOUNT_PATH, FuturesAccount, {}, creds),

      coinmAccount: (creds) => signedGet(dapi, COINM_ACCOUNT_PATH, CoinmAccount, {}, creds),

      fundingAssets: (creds) =>
        signedGet(spot, FUNDING_ASSET_PATH, Schema.Array(FundingAsset), {}, creds, "POST"),

      earnFlexible: (creds) => earnRows(EARN_FLEXIBLE_PATH, EarnFlexibleRow, creds),
      earnLocked: (creds) => earnRows(EARN_LOCKED_PATH, EarnLockedRow, creds),
    };
  });
}
