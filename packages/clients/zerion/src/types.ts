import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// Zerion 响应的**最小形状**(仅取用到的字段)。字段一个没动 —— 换的是「谁说了算」:
// 以前是 `interface` + 一次 `as`,现在是 schema,类型从它推出来。

export const ZerionQuantity = Schema.Struct({ float: maybe(Schema.Number) });
export type ZerionQuantity = typeof ZerionQuantity.Type;

export const ZerionImplementation = Schema.Struct({
  chain_id: maybe(Schema.String),
  address: Schema.optional(Schema.NullOr(Schema.String)), // 原生币为 null
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
  id: maybe(Schema.String), // slug(与 positions 的 relationships.chain 同口径)
  attributes: maybe(Schema.Struct({ external_id: maybe(Schema.String) })), // hex 数字 chainId(如 "0x1")—— 只在此端点给
});
export type ZerionChain = typeof ZerionChain.Type;

export const ZerionChainsResponse = Schema.Struct({ data: maybe(Schema.Array(ZerionChain)) });
export type ZerionChainsResponse = typeof ZerionChainsResponse.Type;
