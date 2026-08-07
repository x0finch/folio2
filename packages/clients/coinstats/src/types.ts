import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// CoinStats 响应的**最小形状**(仅取用到的字段)。字段一个没动 —— 换的是「谁说了算」:
// 以前是 `interface` + 一次 `as`,现在是 schema,类型从它推出来。

// wallet/balance 返回的单条 coin。响应无图标字段 → 适配层不产 logo。
export const CoinstatsCoin = Schema.Struct({
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  amount: maybe(Schema.Number),
  // **`null` 留在类型里**:没价与没给这个字段,适配层分得清。
  price: Schema.optional(Schema.NullOr(Schema.Number)),
  chain: maybe(Schema.String),
  contractAddress: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CoinstatsCoin = typeof CoinstatsCoin.Type;
