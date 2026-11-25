import { Schema } from "effect";
import type { Call } from "../../runtime/define";
import { maybe } from "../../runtime/schema";
import { BALANCE_PATH } from "./constants";

// One coin from wallet/balance; only the fields we read. The response has no icon field.
export const CoinstatsCoin = Schema.Struct({
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  amount: maybe(Schema.Number),
  // `null` stays: no price differs from the field not being given.
  price: Schema.optional(Schema.NullOr(Schema.Number)),
  chain: maybe(Schema.String),
  contractAddress: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CoinstatsCoin = typeof CoinstatsCoin.Type;

// Upstream returns the coin array directly, not `{ data: [...] }`.
export const walletBalance = (call: Call, params: { connectionId: string; address: string }) =>
  call.request(BALANCE_PATH, Schema.Array(CoinstatsCoin), { query: params });
