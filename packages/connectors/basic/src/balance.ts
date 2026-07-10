import { DetailBlock } from "@folio/detail-block-basic";
import { z } from "zod";

// 【Balance —— 类型完备的 4-kind zod 判别联合】(ADR 0010)
// 判别式 kind = 粗粒度资产类别,只驱动跨 connector 的公共逻辑(聚合口径/净值不变量/主表分区路由);
// 渲染差异不由 kind 承载(下沉 detail)。utxo 已并回 spot(BTC 以现货口径聚合),展示细节走 detail 块。
// 净值不变量:账户 totalUsd === Σ value;value = 该仓位对组合净值的【带符号净贡献】
//   · 负债记负;每个经济仓位只有一行承载价值,会被重复计的其余行 value:0
//     (perp 权益行带值、仓位行 0;LP 整池带值、底层币 0)。value 只够加总,展示细节放 meta。
// 每 connector 的 balance.schema = 它会吐的 kind 子集判别联合(组合下方各 kind schema),
// 其余 kind 编译期不可写(见 BalanceProvider<B>)。

// 所有 kind 共享的基座。tokenKey/name/logo/price 由 provider 尽力带,缺则省略。
export const BalanceBase = z.object({
  symbol: z.string(),
  amount: z.number(),
  value: z.number(), // USD 加总权威(原 usdValue);sync 写快照时映射 usdValue
  price: z.number().optional(), // 单价 USD(provider 直接给则带)
  tokenKey: z.string().optional(), // 代币寻址标识(CAIP-19 文法;拿不到则空,退化按 symbol)
  name: z.string().optional(), // provider 自带代币元信息(喂参考层 / 备用展示)
  logo: z.string().optional(),
  // detail:provider 专属、【仅供展示】的结构化块(ADR 0010)。无共享逻辑读它 —— 只被前端
  // <BalanceDetail> 按块 type 渲染(BTC 未确认/派生地址/收款、CEX locked/available…)。
  // 展示细节不再开新 kind、不塞 typed meta;加 provider 详情 = 多吐几个块,前端零改。
  detail: z.array(DetailBlock).optional(),
});

// —— 各 kind 的 meta 契约(随 kind 精确) ——
// spot 从此【零 typed meta】(ADR 0010:SpotMeta/fixed 已删)—— manual 统一走市价重估;
// 展示细节(如 BTC 未确认/派生地址)一律走 BalanceBase.detail,不再塞 typed meta。

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
// spot:纯 BalanceBase(+ 可选 detail),零 typed meta(ADR 0010)。value/渲染是普通代币行;
// BTC 现货也走此 kind,未确认/派生地址/收款等展示细节走 BalanceBase.detail。
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

// detail 块契约(ADR 0010,词汇表 v1)从 @folio/detail-block-basic 转出:BalanceBase.detail 用它,
// provider(拼块)/ db(落库)/ 读端 可经契约层单一入口取型,无需各自直依 detail-block-basic。
export type { DetailBlock } from "@folio/detail-block-basic";
