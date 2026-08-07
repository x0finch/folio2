import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// Rabby(实为 DeBank 后端)响应的**最小形状** —— 只声明我们真正取用的字段。
// api.rabby.io 没有公开契约,所以这里刻意窄:字段越少,上游改形状时被牵连的面越小。
//
// 字段一个没动 —— 换的是「谁说了算」:以前是 `interface` + 一次 `as`(声明而已,运行时没人查),
// 现在是 schema,类型从它推出来。

// /v1/chain/list —— `community_id` 就是规范 EVM chainId(抽查 15 条全中:eth=1 bsc=56 arb=42161 …)。
export const RabbyChain = Schema.Struct({
  id: maybe(Schema.String), // 链 slug,与持仓行的 `chain` 同口径
  community_id: maybe(Schema.Number),
});
export type RabbyChain = typeof RabbyChain.Type;

// /v1/user/cache_token_list 的一行。**只收地址、一次回全链**,是替代 Zerion positions 的那一发。
// 注意:没有 usd_value 字段 —— 价值要自己 amount × price 算。
export const RabbyToken = Schema.Struct({
  id: maybe(Schema.String), // 合约地址(0x…),**原生 gas 币时等于链 slug**
  chain: maybe(Schema.String),
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  logo_url: Schema.optional(Schema.NullOr(Schema.String)),
  amount: maybe(Schema.Number),
  // 上游认不出价的币给 0(不是 null)——实测 2302 行里 814 行如此。
  price: Schema.optional(Schema.NullOr(Schema.Number)),
  is_scam: maybe(Schema.Boolean),
  is_suspicious: maybe(Schema.Boolean),
});
export type RabbyToken = typeof RabbyToken.Type;

// /v1/user/complex_protocol_list —— 同样一次回全链的 DeFi 仓位。
export const RabbyProtocolItem = Schema.Struct({
  name: maybe(Schema.String), // 仓位类型的展示名:Lending / Vesting / Liquidity Pool …
  detail: maybe(
    Schema.Struct({
      // 实测出现过的形状(fixture 钉的):三个列表 + 单数的 `token`。
      // 其余键(description / health_rate / unlock_at / end_at)是纯展示,不产行。
      supply_token_list: maybe(Schema.Array(RabbyToken)),
      reward_token_list: maybe(Schema.Array(RabbyToken)),
      borrow_token_list: maybe(Schema.Array(RabbyToken)), // 负债腿。**amount 是正数**,取负由我们做
      token: maybe(RabbyToken),
    }),
  ),
});
export type RabbyProtocolItem = typeof RabbyProtocolItem.Type;

export const RabbyProtocol = Schema.Struct({
  id: maybe(Schema.String),
  name: maybe(Schema.String),
  logo_url: maybe(Schema.String), // 协议顶层 logo(与 per-token logo_url 不同层);#126 采集为 meta.protocolLogo
  portfolio_item_list: maybe(Schema.Array(RabbyProtocolItem)),
});
export type RabbyProtocol = typeof RabbyProtocol.Type;
