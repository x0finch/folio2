import { UpstreamUnavailableError } from "@folio/upstream-basic";
import { Effect, Schema } from "effect";
import type { Call } from "../../runtime/define";
import { maybe } from "../../runtime/schema";
import { staleTolerantCache } from "../../runtime/stale-cache";
import {
  CHAINS_CACHE_TTL_MS,
  CHAINS_PATH,
  ID,
  POSITIONS_QUERY,
  portfolioPath,
  positionsPath,
} from "./constants";

// Only the fields we read.

const ZerionImplementation = Schema.Struct({
  chain_id: maybe(Schema.String),
  address: Schema.optional(Schema.NullOr(Schema.String)), // null for native coins
});

const ZerionPosition = Schema.Struct({
  attributes: maybe(
    Schema.Struct({
      protocol: Schema.optional(Schema.NullOr(Schema.String)),
      position_type: maybe(Schema.String),
      quantity: maybe(Schema.Struct({ float: maybe(Schema.Number) })),
      value: Schema.optional(Schema.NullOr(Schema.Number)),
      price: Schema.optional(Schema.NullOr(Schema.Number)),
      fungible_info: maybe(
        Schema.Struct({
          symbol: maybe(Schema.String),
          name: maybe(Schema.String),
          icon: Schema.optional(Schema.NullOr(Schema.Struct({ url: maybe(Schema.String) }))),
          implementations: maybe(Schema.Array(ZerionImplementation)),
        }),
      ),
      flags: maybe(Schema.Struct({ displayable: maybe(Schema.Boolean) })),
    }),
  ),
  relationships: maybe(
    Schema.Struct({
      chain: maybe(Schema.Struct({ data: maybe(Schema.Struct({ id: maybe(Schema.String) })) })),
    }),
  ),
});

export const ZerionPositionsResponse = Schema.Struct({ data: maybe(Schema.Array(ZerionPosition)) });
export type ZerionPositionsResponse = typeof ZerionPositionsResponse.Type;

const ZerionChain = Schema.Struct({
  id: maybe(Schema.String), // slug, as in a position's relationships.chain
  attributes: maybe(Schema.Struct({ external_id: maybe(Schema.String) })), // hex chainId, e.g. "0x1"
});

export const ZerionChainsResponse = Schema.Struct({ data: maybe(Schema.Array(ZerionChain)) });
export type ZerionChainsResponse = typeof ZerionChainsResponse.Type;

export function parseChainIds(res: ZerionChainsResponse): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of res.data ?? []) {
    const hex = c.attributes?.external_id;
    if (!c.id || !hex) continue;
    const n = Number.parseInt(hex, 16);
    if (Number.isFinite(n)) out[c.id] = n;
  }
  return out;
}

// Tokens and DeFi across every EVM chain in one response.
export const positions = (call: Call, address: string) =>
  call.request(positionsPath(address), ZerionPositionsResponse, { query: POSITIONS_QUERY });

// Only whether key and address work matters, so no shape is declared.
export const portfolio = (call: Call, address: string) =>
  call.request(portfolioPath(address), Schema.Unknown);

// Cached so every account doesn't spend the shared key's quota on an immutable list.
export const chainIds = (call: Call) =>
  staleTolerantCache<Record<string, number>>({
    upstream: ID,
    name: "chains",
    scope: call.base,
    ttlMs: CHAINS_CACHE_TTL_MS,
    // A 200 with an empty list would block canonical refs for a whole day: treat it as a miss.
    isEmpty: (map) => Object.keys(map).length === 0,
    onEmpty: () =>
      new UpstreamUnavailableError({
        upstream: ID,
        where: CHAINS_PATH,
        cause: "chains response contained no usable chainIds",
      }),
  }).get(call.request(CHAINS_PATH, ZerionChainsResponse).pipe(Effect.map(parseChainIds)));
