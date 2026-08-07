import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// `clearinghouseState` 响应的**最小形状**(仅取用到的字段)。字段一个没动 —— 换的是「谁说了算」:
// 以前是 `interface` + 一次 `as`(声明而已,运行时没人查),现在是 schema,类型从它推出来。
//
// 数字字段全是 `string`:hyperliquid 用字符串传数字。转数字归适配层。

export const HlLeverage = Schema.Struct({
  value: maybe(Schema.Number),
  type: maybe(Schema.String),
  rawUsd: maybe(Schema.String),
});
export type HlLeverage = typeof HlLeverage.Type;

export const HlPosition = Schema.Struct({
  coin: maybe(Schema.String),
  szi: maybe(Schema.String), // 带符号:正=多、负=空
  entryPx: maybe(Schema.String),
  positionValue: maybe(Schema.String), // 名义 USD(杠杆敞口,非账户净值贡献)
  unrealizedPnl: maybe(Schema.String),
  leverage: maybe(HlLeverage),
  // **这个 `null` 留在类型里**:没有强平价与「没给这个字段」是两回事,适配层分得清。
  liquidationPx: Schema.optional(Schema.NullOr(Schema.String)),
  marginUsed: maybe(Schema.String),
});
export type HlPosition = typeof HlPosition.Type;

export const HlMarginSummary = Schema.Struct({
  accountValue: maybe(Schema.String), // 账户总权益(保证金 + 未实现盈亏)= 对组合净值的真实贡献
  totalMarginUsed: maybe(Schema.String),
  totalNtlPos: maybe(Schema.String),
  totalRawUsd: maybe(Schema.String),
});
export type HlMarginSummary = typeof HlMarginSummary.Type;

export const ClearinghouseState = Schema.Struct({
  marginSummary: maybe(HlMarginSummary),
  assetPositions: maybe(Schema.Array(Schema.Struct({ position: maybe(HlPosition) }))),
  withdrawable: maybe(Schema.String),
});
export type ClearinghouseState = typeof ClearinghouseState.Type;
