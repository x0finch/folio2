import {
  makeRateLimit,
  makeRequester,
  type Outbound,
  type Requester,
  type RequestOptions,
  type SigningFailure,
  staleTolerantCache,
  type UpstreamError,
  UpstreamUnavailableError,
} from "@folio/client-core";
import { Context, Duration, Effect, Layer, Schema, type Scope } from "effect";
import {
  CACHE_TOKEN_LIST_PATH,
  CHAIN_LIST_PATH,
  CHAINS_CACHE_TTL_MS,
  COMPLEX_PROTOCOL_LIST_PATH,
  MAX_REQUESTS_PER_SECOND,
  RABBY_API_BASE,
  RATE_LIMIT_KEY,
  TOTAL_BALANCE_PATH,
  UPSTREAM,
} from "./constants";
import { currentSigner } from "./signer";
import { RabbyChain, RabbyProtocol, RabbyToken } from "./types";

export interface RabbyConfig {
  // Base URL, used as one opaque string. No proxy-override need here, but the chain-mapping cache is bucketed by it, so tests isolate naturally.
  readonly apiBase?: string;
}

// Request layer for Rabby (a DeBank backend): methods follow upstream endpoints and return upstream shapes (DTOs); `parseTokens` /
// `parseProtocols` (junk filter, debt legs negated, protocol position expansion), `tokenRef` naming and dust filtering are in the adapter.
// Needs no API key (its main gain over zerion), at the cost of signing every request: see sign.ts.
export interface RabbyClientApi {
  // Wallet tokens: address only, all chains in one response. Upstream has no usd_value field, so value is amount x price computed by us.
  readonly tokens: (
    address: string,
  ) => Effect.Effect<readonly RabbyToken[], UpstreamError, Outbound>;
  // DeFi positions, likewise all chains in one response.
  readonly protocols: (
    address: string,
  ) => Effect.Effect<readonly RabbyProtocol[], UpstreamError, Outbound>;
  // slug to numeric chainId (`community_id` is the canonical EVM chainId), with a 24h cache.
  readonly chainIds: Effect.Effect<Record<string, number>, UpstreamError, Outbound>;
  // The lightest endpoint, for liveness probes.
  readonly totalBalance: (address: string) => Effect.Effect<unknown, UpstreamError, Outbound>;
}

export class RabbyClient extends Context.Service<RabbyClient, RabbyClientApi>()("clients/Rabby") {
  static readonly layer = (config: RabbyConfig = {}): Layer.Layer<RabbyClient> =>
    Layer.effect(RabbyClient, make(config));
}

// `community_id` is the canonical EVM chainId (15 spot checks all matched: eth=1 bsc=56 arb=42161 …).
// This conversion stays in the client: it is "reading how upstream speaks", with no folio concept.
export function parseChainIds(chains: readonly RabbyChain[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of chains ?? []) {
    if (!c.id || typeof c.community_id !== "number") continue;
    if (Number.isFinite(c.community_id)) out[c.id] = c.community_id;
  }
  return out;
}

export function make(config: RabbyConfig = {}): Effect.Effect<RabbyClientApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const baseUrl = config.apiBase ?? RABBY_API_BASE;

    // limit=1: no bursts. Rabby throttles instantaneous concurrency, not total volume (see constants.ts).
    const limit = yield* makeRateLimit({
      key: RATE_LIMIT_KEY,
      limit: 1,
      interval: Duration.millis(1000 / MAX_REQUESTS_PER_SECOND),
    });

    // Signing header. `params` must equal the query actually sent (it is what is signed; upstream hashes it sorted by key). `options.query` is
    // the very copy `makeRequester` appends to the URL, so it matches by construction, unlike bybit / okx which rebuild the query string.
    const signedHeaders = (
      path: string,
      options: RequestOptions | undefined,
    ): Effect.Effect<HeadersInit, SigningFailure> =>
      Effect.gen(function* () {
        const sign = yield* currentSigner;
        const params = (options?.query ?? {}) as Record<string, unknown>;
        return { ...(yield* sign("GET", path, params)), accept: "application/json" };
      });

    const request: Requester = makeRequester({
      baseUrl,
      upstream: UPSTREAM,
      limit,
      headers: signedHeaders,
    });

    const chainsCache = staleTolerantCache<Record<string, number>>({
      upstream: UPSTREAM,
      name: "chains",
      scope: baseUrl,
      ttlMs: CHAINS_CACHE_TTL_MS,
      // A 200 with an empty list would block canonical identifiers for a whole day: treat as not fetched.
      isEmpty: (map) => Object.keys(map).length === 0,
      onEmpty: () =>
        new UpstreamUnavailableError({
          upstream: UPSTREAM,
          where: CHAIN_LIST_PATH,
          cause: "chain list contained no usable chainIds",
        }),
    });

    return {
      tokens: (address) =>
        request(CACHE_TOKEN_LIST_PATH, Schema.Array(RabbyToken), { query: { id: address } }),

      protocols: (address) =>
        request(COMPLEX_PROTOCOL_LIST_PATH, Schema.Array(RabbyProtocol), {
          query: { id: address },
        }),

      chainIds: chainsCache.get(
        request(CHAIN_LIST_PATH, Schema.Array(RabbyChain)).pipe(Effect.map(parseChainIds)),
      ),

      totalBalance: (
        address, // only probes whether this address works; the response shape does not matter, so none is declared.
      ) => request(TOTAL_BALANCE_PATH, Schema.Unknown, { query: { id: address } }),
    };
  });
}
