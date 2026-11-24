import { maybe } from "@folio/upstreams";
import { Schema } from "effect";

// Minimal shape of the CoinStats response (only the fields used). Types derive from the schema.

// One coin from wallet/balance. The response has no icon field, so the adapter produces no logo.
export const CoinstatsCoin = Schema.Struct({
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  amount: maybe(Schema.Number),
  // `null` stays in the type: no price differs from the field not being given, and the adapter tells them apart.
  price: Schema.optional(Schema.NullOr(Schema.Number)),
  chain: maybe(Schema.String),
  contractAddress: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CoinstatsCoin = typeof CoinstatsCoin.Type;
