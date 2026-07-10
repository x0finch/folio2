import { z } from "zod";

// 【Balance —— 类型完备的 4-kind zod 判别联合】(ADR 0009 / spike markdown-detail)
// 判别式 kind = "一套独有 meta + 渲染契约"的扁平判别(非资产/链/来源)。
// 净值不变量:账户 totalUsd === Σ value;value = 该仓位对组合净值的【带符号净贡献】
//   · 负债记负;每个经济仓位只有一行承载价值,会被重复计的其余行 value:0
//     (perp 权益行带值、仓位行 0;LP 整池带值、底层币 0)。value 只够加总,展示细节放 meta/detail。
// 每 connector 的 balance.schema = 它会吐的 kind 子集判别联合(组合下方各 kind schema),
// 其余 kind 编译期不可写(见 BalanceProvider<B>)。

// 所有 kind 共享的基座。tokenKey/name/logo/price 由 provider 尽力带,缺则省略。
// detail:provider 拼好的 markdown 字符串(按持仓渲染的展示细节,如 BTC 未确认/派生地址、CEX
//   available/locked)。全站唯一不跟随显示币种/语言的部分(永久英文 + USD)—— provider 在同步
//   时焊死并入快照,前端 react-markdown 直渲(见 spike markdown-detail)。
export const BalanceBase = z.object({
  symbol: z.string(),
  amount: z.number(),
  value: z.number(), // USD 加总权威(原 usdValue);sync 写快照时映射 usdValue
  price: z.number().optional(), // 单价 USD(provider 直接给则带)
  tokenKey: z.string().optional(), // 代币寻址标识(CAIP-19 文法;拿不到则空,退化按 symbol)
  name: z.string().optional(), // provider 自带代币元信息(喂参考层 / 备用展示)
  logo: z.string().optional(),
  detail: z.string().optional(), // provider 拼的 markdown 展示细节(可选)
});

// —— 各 kind 的 meta 契约(随 kind 精确) ——

// defi:协议内仓位。consumer 按 protocol 分组、按 positionType 展示。
export const DefiMeta = z.object({
  protocol: z.string().optional(),
  positionType: z.string().optional(),
});

// perp_equity:永续账户权益行(净值载体,value = 账户净值)。
export const PerpEquityMeta = z.object({
  withdrawable: z.number(),
  totalMarginUsed: z.number(),
  totalNtlPos: z.number(),
});

// perp_position:单个永续仓位(value:0,名义敞口在 meta)。
export const PerpPositionMeta = z.object({
  side: z.enum(["long", "short"]),
  entryPx: z.number(),
  positionValue: z.number(), // 名义敞口 USD(非净值贡献)
  unrealizedPnl: z.number(),
  leverage: z.number().optional(),
  leverageType: z.string().optional(),
  liquidationPx: z.number().nullable(),
  marginUsed: z.number(),
});

// —— 各 kind schema(connector 组合子集用) ——
// spot:普通代币行,无 meta。展示细节(BTC/CEX)一律走 BalanceBase.detail 的 markdown。
export const Spot = BalanceBase.extend({ kind: z.literal("spot") });
export const Defi = BalanceBase.extend({ kind: z.literal("defi"), meta: DefiMeta });
export const PerpEquity = BalanceBase.extend({
  kind: z.literal("perp_equity"),
  meta: PerpEquityMeta,
});
export const PerpPosition = BalanceBase.extend({
  kind: z.literal("perp_position"),
  meta: PerpPositionMeta,
});

// 全集判别联合 —— 聚合/读端消费的完备 Balance。
export const Balance = z.discriminatedUnion("kind", [Spot, Defi, PerpEquity, PerpPosition]);

export type Balance = z.infer<typeof Balance>;
export type BalanceKind = Balance["kind"];
export type Spot = z.infer<typeof Spot>;
export type Defi = z.infer<typeof Defi>;
export type PerpEquity = z.infer<typeof PerpEquity>;
export type PerpPosition = z.infer<typeof PerpPosition>;
export type DefiMeta = z.infer<typeof DefiMeta>;
export type PerpEquityMeta = z.infer<typeof PerpEquityMeta>;
export type PerpPositionMeta = z.infer<typeof PerpPositionMeta>;
