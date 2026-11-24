import { maybe } from "@folio/upstreams";
import { Schema } from "effect";

// Minimal shape of the Zerion response (only the fields used). Types derive from the schema.

export const ZerionQuantity = Schema.Struct({ float: maybe(Schema.Number) });
export type ZerionQuantity = typeof ZerionQuantity.Type;

export const ZerionImplementation = Schema.Struct({
  chain_id: maybe(Schema.String),
  address: Schema.optional(Schema.NullOr(Schema.String)), // null for native coins
});
export type ZerionImplementation = typeof ZerionImplementation.Type;

export const ZerionPosition = Schema.Struct({
  attributes: maybe(
    Schema.Struct({
      protocol: Schema.optional(Schema.NullOr(Schema.String)),
      position_type: maybe(Schema.String),
      quantity: maybe(ZerionQuantity),
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
export type ZerionPosition = typeof ZerionPosition.Type;

export const ZerionPositionsResponse = Schema.Struct({ data: maybe(Schema.Array(ZerionPosition)) });
export type ZerionPositionsResponse = typeof ZerionPositionsResponse.Type;

export const ZerionChain = Schema.Struct({
  id: maybe(Schema.String), // slug (same convention as positions' relationships.chain)
  attributes: maybe(Schema.Struct({ external_id: maybe(Schema.String) })), // hex chainId (e.g. "0x1"), given only by this endpoint
});
export type ZerionChain = typeof ZerionChain.Type;

export const ZerionChainsResponse = Schema.Struct({ data: maybe(Schema.Array(ZerionChain)) });
export type ZerionChainsResponse = typeof ZerionChainsResponse.Type;
