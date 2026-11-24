import type { UpstreamError } from "@folio/upstream-basic";
import { makeRateLimit, makeRequester, type Outbound, type Requester } from "@folio/upstreams";
import { Context, Duration, Effect, Layer, Schema, type Scope } from "effect";
import {
  API_KEY_HEADER,
  BALANCE_PATH,
  BLOCKCHAINS_PATH,
  COINSTATS_API_BASE,
  RATE_LIMIT_BURST,
  RATE_LIMIT_KEY,
  RATE_LIMIT_PER_SEC,
  UPSTREAM,
} from "./constants";
import { CoinstatsCoin } from "./types";

export interface CoinstatsConfig {
  // Base URL, used as one opaque string. No proxy-override need here; the knob keeps the clients' shape uniform.
  readonly apiBase?: string;
}

// Request layer for the CoinStats OpenAPI: methods follow upstream endpoints and return upstream shapes (DTOs); `parseBalances`, `tokenRef`
// naming and the "coin without chain falls back to connectionId" rule are in the adapter.
// `apiKey` and `connectionId` are passed per call, not bound at construction: the key comes from ctx.creds (the client reads no env), and
// connectionId is CoinStats' chain identifier (a query param) whose mapping to a chain is adapter knowledge.
export interface CoinstatsClientApi {
  // Wallet token balances. Upstream returns a coin array directly (not { data: [...] }).
  readonly balance: (params: {
    readonly connectionId: string;
    readonly address: string;
    readonly apiKey: string;
  }) => Effect.Effect<readonly CoinstatsCoin[], UpstreamError, Outbound>;

  // List of supported chains. Needs only a key, no address: verifies the key is actually valid, not just non-empty.
  // The return value is unread (callers care only about success), so the type is `unknown`: better than declaring a fake shape.
  readonly blockchains: (apiKey: string) => Effect.Effect<unknown, UpstreamError, Outbound>;
}

export class CoinstatsClient extends Context.Service<CoinstatsClient, CoinstatsClientApi>()(
  "clients/Coinstats",
) {
  static readonly layer = (config: CoinstatsConfig = {}): Layer.Layer<CoinstatsClient> =>
    Layer.effect(CoinstatsClient, make(config));
}

export function make(
  config: CoinstatsConfig = {},
): Effect.Effect<CoinstatsClientApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const limit = yield* makeRateLimit({
      key: RATE_LIMIT_KEY,
      limit: RATE_LIMIT_BURST,
      interval: Duration.millis((RATE_LIMIT_BURST / RATE_LIMIT_PER_SEC) * 1000),
    });

    const request: Requester = makeRequester({
      baseUrl: config.apiBase ?? COINSTATS_API_BASE,
      upstream: UPSTREAM,
      limit,
    });

    // Headers are computed per request: the key comes from the caller's credentials, not a module constant.
    const keyed = (apiKey: string) =>
      Effect.succeed({ [API_KEY_HEADER]: apiKey, accept: "application/json" });

    return {
      balance: ({ connectionId, address, apiKey }) =>
        request(BALANCE_PATH, Schema.Array(CoinstatsCoin), {
          query: { address, connectionId },
          headers: keyed(apiKey),
        }),

      // Only probes whether this key works; the response shape does not matter, so none is declared.
      blockchains: (apiKey) =>
        request(BLOCKCHAINS_PATH, Schema.Unknown, { headers: keyed(apiKey) }),
    };
  });
}
