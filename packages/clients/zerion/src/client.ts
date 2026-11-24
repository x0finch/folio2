import { makeRateLimit, makeRequester, type Outbound, type Requester } from "@folio/client-core";
import type { UpstreamError } from "@folio/upstream-basic";
import { Context, Duration, Effect, Layer, Schema, type Scope } from "effect";
import { chainsCacheFor, parseChainIds } from "./chains";
import {
  CHAINS_PATH,
  POSITIONS_QUERY,
  portfolioPath,
  positionsPath,
  RATE_LIMIT_BURST,
  RATE_LIMIT_KEY,
  RATE_LIMIT_PER_SEC,
  UPSTREAM,
  ZERION_API_BASE,
} from "./constants";
import { ZerionChainsResponse, ZerionPositionsResponse } from "./types";

export interface ZerionConfig {
  // Base URL, used as one opaque string. No proxy-override need here, but the chain-mapping cache is bucketed by it, so tests isolate naturally.
  readonly apiBase?: string;
}

// Request layer for the Zerion API: methods follow upstream endpoints and return upstream shapes (DTOs); `parsePositions` (spot/defi
// discrimination, debt legs negated, displayable filter) and `tokenRef` naming are in the adapter.
// `apiKey` is passed per call (from ctx.creds; the client reads no env). Auth is HTTP Basic: key as username, empty password.
export interface ZerionClientApi {
  // All positions of the address (tokens + DeFi, across all EVM chains in one response).
  readonly positions: (params: {
    readonly address: string;
    readonly apiKey: string;
  }) => Effect.Effect<ZerionPositionsResponse, UpstreamError, Outbound>;

  // slug to numeric chainId, with a 24h cache (chains-cache.ts): the chain list is near-static. A failed refresh falls back to the old mapping, still correct.
  readonly chainIds: (
    apiKey: string,
  ) => Effect.Effect<Record<string, number>, UpstreamError, Outbound>;

  // Light aggregate for liveness probes; far smaller than positions.
  readonly portfolio: (params: {
    readonly address: string;
    readonly apiKey: string;
  }) => Effect.Effect<unknown, UpstreamError, Outbound>;
}

export class ZerionClient extends Context.Service<ZerionClient, ZerionClientApi>()(
  "clients/Zerion",
) {
  static readonly layer = (config: ZerionConfig = {}): Layer.Layer<ZerionClient> =>
    Layer.effect(ZerionClient, make(config));
}

// Zerion's Basic auth shape: key as username, empty password.
const basicAuth = (apiKey: string): string => `Basic ${btoa(`${apiKey}:`)}`;

export function make(
  config: ZerionConfig = {},
): Effect.Effect<ZerionClientApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const baseUrl = config.apiBase ?? ZERION_API_BASE;

    const limit = yield* makeRateLimit({
      key: RATE_LIMIT_KEY,
      limit: RATE_LIMIT_BURST,
      interval: Duration.millis((RATE_LIMIT_BURST / RATE_LIMIT_PER_SEC) * 1000),
    });

    const request: Requester = makeRequester({ baseUrl, upstream: UPSTREAM, limit });

    // Headers are computed per request: the key comes from the caller's credentials, not a module constant.
    const keyed = (apiKey: string) =>
      Effect.succeed({ Authorization: basicAuth(apiKey), accept: "application/json" });

    // The cache is bucketed by baseUrl and lives at module level (client-core's stale-cache: a Scope is reset every request).
    const chainsCache = chainsCacheFor(baseUrl);

    return {
      positions: ({ address, apiKey }) =>
        request(positionsPath(address), ZerionPositionsResponse, {
          query: POSITIONS_QUERY,
          headers: keyed(apiKey),
        }),

      chainIds: (apiKey) =>
        chainsCache.get(
          request(CHAINS_PATH, ZerionChainsResponse, { headers: keyed(apiKey) }).pipe(
            Effect.map(parseChainIds),
          ),
        ),

      portfolio: ({ address, apiKey }) =>
        // Only probes whether this key + address works; the response shape does not matter.
        request(portfolioPath(address), Schema.Unknown, { headers: keyed(apiKey) }),
    };
  });
}
