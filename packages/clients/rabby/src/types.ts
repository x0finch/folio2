import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// Minimal shape of Rabby (DeBank backend) responses: only the fields we use. api.rabby.io has no public contract, so this is deliberately narrow:
// the fewer fields, the smaller the surface hit when upstream changes shape. Types derive from the schema.

// /v1/chain/list: `community_id` is the canonical EVM chainId (15 spot checks all matched: eth=1 bsc=56 arb=42161 …).
export const RabbyChain = Schema.Struct({
  id: maybe(Schema.String), // chain slug, same convention as the holding row's `chain`
  community_id: maybe(Schema.Number),
});
export type RabbyChain = typeof RabbyChain.Type;

// One row of /v1/user/cache_token_list. Address only, all chains in one response: the request that replaces Zerion positions.
// There is no usd_value field: value is amount x price computed by us.
export const RabbyToken = Schema.Struct({
  id: maybe(Schema.String), // contract address (0x…); for the native gas token it equals the chain slug
  chain: maybe(Schema.String),
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  logo_url: Schema.optional(Schema.NullOr(Schema.String)),
  amount: maybe(Schema.Number),
  // Upstream gives 0 (not null) for tokens it cannot price (814 of 2302 rows measured).
  price: Schema.optional(Schema.NullOr(Schema.Number)),
  is_scam: maybe(Schema.Boolean),
  is_suspicious: maybe(Schema.Boolean),
});
export type RabbyToken = typeof RabbyToken.Type;

// /v1/user/complex_protocol_list: DeFi positions, likewise all chains in one response.
export const RabbyProtocolItem = Schema.Struct({
  name: maybe(Schema.String), // display name of the position type: Lending / Vesting / Liquidity Pool …
  detail: maybe(
    Schema.Struct({
      // Shapes observed (pinned by the fixture): three lists + a singular `token`.
      // The other keys (description / health_rate / unlock_at / end_at) are display only and produce no row.
      supply_token_list: maybe(Schema.Array(RabbyToken)),
      reward_token_list: maybe(Schema.Array(RabbyToken)),
      borrow_token_list: maybe(Schema.Array(RabbyToken)), // debt leg; amount is positive, negation is ours to do
      token: maybe(RabbyToken),
    }),
  ),
});
export type RabbyProtocolItem = typeof RabbyProtocolItem.Type;

export const RabbyProtocol = Schema.Struct({
  id: maybe(Schema.String),
  name: maybe(Schema.String),
  logo_url: maybe(Schema.String), // protocol-level logo (a different level from per-token logo_url); collected as meta.protocolLogo
  portfolio_item_list: maybe(Schema.Array(RabbyProtocolItem)),
});
export type RabbyProtocol = typeof RabbyProtocol.Type;
