import { UpstreamUnavailableError } from "@folio/upstream-basic";
import { Effect, Schema } from "effect";
import type { Call } from "../../runtime/define";
import { maybe } from "../../runtime/schema";
import { staleTolerantCache } from "../../runtime/stale-cache";
import {
  CACHE_TOKEN_LIST_PATH,
  CHAIN_LIST_PATH,
  CHAINS_CACHE_TTL_MS,
  COMPLEX_PROTOCOL_LIST_PATH,
  ID,
  TOTAL_BALANCE_PATH,
} from "./constants";
import { currentSigner } from "./signer";

// api.rabby.io has no public contract: declare as few fields as possible.

export const RabbyChain = Schema.Struct({
  id: maybe(Schema.String), // chain slug, as in a token's `chain`
  community_id: maybe(Schema.Number), // the canonical EVM chainId
});
export type RabbyChain = typeof RabbyChain.Type;

// No usd_value field: value is amount × price, computed by us.
export const RabbyToken = Schema.Struct({
  id: maybe(Schema.String), // contract address; the chain slug for the native gas coin
  chain: maybe(Schema.String),
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  logo_url: Schema.optional(Schema.NullOr(Schema.String)),
  amount: maybe(Schema.Number),
  // 0 (not null) for tokens it can't price.
  price: Schema.optional(Schema.NullOr(Schema.Number)),
  is_scam: maybe(Schema.Boolean),
  is_suspicious: maybe(Schema.Boolean),
});
export type RabbyToken = typeof RabbyToken.Type;

const RabbyProtocolItem = Schema.Struct({
  name: maybe(Schema.String), // position type: Lending / Vesting / Liquidity Pool …
  detail: maybe(
    Schema.Struct({
      // Display-only keys (description / health_rate / unlock_at …) produce no row.
      supply_token_list: maybe(Schema.Array(RabbyToken)),
      reward_token_list: maybe(Schema.Array(RabbyToken)),
      borrow_token_list: maybe(Schema.Array(RabbyToken)), // debt, with a positive amount
      token: maybe(RabbyToken),
    }),
  ),
});

export const RabbyProtocol = Schema.Struct({
  id: maybe(Schema.String),
  name: maybe(Schema.String),
  logo_url: maybe(Schema.String), // the protocol's, not a token's
  portfolio_item_list: maybe(Schema.Array(RabbyProtocolItem)),
});
export type RabbyProtocol = typeof RabbyProtocol.Type;

export function parseChainIds(chains: readonly RabbyChain[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of chains ?? []) {
    if (!c.id || typeof c.community_id !== "number") continue;
    if (Number.isFinite(c.community_id)) out[c.id] = c.community_id;
  }
  return out;
}

// The signature covers the query, so it must be signed from the very object that is sent.
const signed = <A, I>(
  call: Call,
  path: string,
  schema: Schema.Codec<A, I>,
  query: Record<string, string> = {},
) =>
  call.request(path, schema, {
    query,
    headers: Effect.flatMap(currentSigner, (sign) => sign("GET", path, query)),
  });

// Both answer for all chains at once.
export const tokens = (call: Call, address: string) =>
  signed(call, CACHE_TOKEN_LIST_PATH, Schema.Array(RabbyToken), { id: address });

export const protocols = (call: Call, address: string) =>
  signed(call, COMPLEX_PROTOCOL_LIST_PATH, Schema.Array(RabbyProtocol), { id: address });

// Only whether the address works matters, so no shape is declared.
export const totalBalance = (call: Call, address: string) =>
  signed(call, TOTAL_BALANCE_PATH, Schema.Unknown, { id: address });

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
        where: CHAIN_LIST_PATH,
        cause: "chain list contained no usable chainIds",
      }),
  }).get(signed(call, CHAIN_LIST_PATH, Schema.Array(RabbyChain)).pipe(Effect.map(parseChainIds)));
