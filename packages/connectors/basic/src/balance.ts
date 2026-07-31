import { z } from "zod";
import { Note } from "./note";

// 【Balance —— 类型完备的 4-kind zod 判别联合】(ADR 0009 → 0010:utxo 并回 spot)
// 判别式 kind = "一套独有 meta + 渲染契约"的扁平判别(非资产/链/来源)。
// 净值不变量:账户 totalUsd === Σ value;value = 该仓位对组合净值的【带符号净贡献】
//   · 负债记负;每个经济仓位只有一行承载价值,会被重复计的其余行 value:0
//     (perp 权益行带值、仓位行 0;LP 整池带值、底层币 0)。value 只够加总,展示细节放 meta。
// 每 connector 的 balance.schema = 它会吐的 kind 子集判别联合(组合下方各 kind schema),
// 其余 kind 编译期不可写(见 BalanceProvider<B>)。

// 所有 kind 共享的基座。tokenRef 必填(见其注释);name/logo/price 由 provider 尽力带,缺则省略。
export const BalanceBase = z.object({
  symbol: z.string(),
  amount: z.number(),
  value: z.number(), // USD 加总权威(原 usdValue);sync 写快照时映射 usdValue
  price: z.number().optional(), // 单价 USD(provider 直接给则带)
  // provider 自带单价(oracle 多源 Phase 3):revalue 从原始余额捕获(price ?? value/amount),
  // 落 snapshot_balances.self_price —— 作估值「原料」,让切换源/估值模式能从原料重算、可逆、自带价不丢。
  // 与 price 分开:price 可能被 revalue 改成源价,selfPrice 恒为 provider 原值。
  selfPrice: z.number().optional(),
  // 代币命名(ADR 0020 文法)。**必填** —— provider 总能说出「我管这个币叫什么」:链上是
  // `<链>/<地址>` 或 `<链>/native`,场馆是 `<场馆>/<代号>`,手记是用户选的 `coingecko/<id>`
  // 或 `manual/<symbol>`。造不出规范标识的行不产(见各 producer),不再有「拿不到就空着」这一档。
  // 平台(链 ∪ 场馆)由写路径从它的命名者推出并落库,不占 Balance 一个字段(#193)。
  tokenRef: z.string(),
  name: z.string().optional(), // provider 自带代币元信息(喂参考层 / 备用展示)
  logo: z.string().optional(),
  // provider 专属【仅供展示】的 balance 级 note(note 重设计,单个 Note),挂在【这笔持仓】上:
  // CEX → 该币的锁仓/冻结(一段)。落 snapshot_balances.note(JSON),前端渲染成该行标题右侧的
  // 小 icon + hover popover。无共享逻辑读它 —— 纯展示。account 级 note(Note[])见 fetchBalances 顶层返回。
  note: Note.optional(),
});

// —— 各 kind 的 meta 契约(随 kind 精确) ——
// spot 零 typed meta(ADR 0010:删 SpotMeta/fixed —— 锁定固定值未用到;manual 统一走市价重估)。

// defi:协议内仓位。consumer 按 protocol 分组、按 positionType 展示。
export const DefiMeta = z.object({
  protocol: z.string().optional(),
  positionType: z.string().optional(),
  // 协议 logo 的上游 URL(provider 随协议报,如 Rabby 的 `p.logo_url`)。仅供展示:随 meta 落进
  // 快照,`/api/logo/defi` 代理据此在服务端解析出图(客户端零第三方 CDN,ADR 0008 / #126)。
  // 老快照无此字段 → 协议行退回首字母兜底(零迁移)。
  protocolLogo: z.string().optional(),
});

// perp_equity:永续账户权益行(净值载体,value = 账户净值)。
export const PerpEquityMeta = z.object({
  withdrawable: z.number(),
  totalMarginUsed: z.number(),
  totalNtlPos: z.number(),
});

// perp_position:单个永续仓位(value:0,名义敞口在 meta)。
export const PerpPositionMeta = z.object({
  // 标的币代号(BTC / ETH …)。永续仓位是衍生品、不是持仓,展示用的币名是它的固有属性,
  // 与 side/entryPx 同类住在 meta —— 不再依赖已删的 snapshot_balances.symbol 列(#243)。
  coin: z.string(),
  side: z.enum(["long", "short"]),
  entryPx: z.number(),
  positionValue: z.number(), // 名义敞口 USD(非净值贡献)
  unrealizedPnl: z.number(),
  leverage: z.number().optional(),
  leverageType: z.string().optional(),
  liquidationPx: z.number().nullable(),
  marginUsed: z.number(),
});

// BTC(及将来 UTXO 链)不再是独立 kind —— 并回 spot(ADR 0010:主表本就当现货聚合,其「独有」的
// 未确认/派生地址/收款全是展示细节,已由 account 级 Note[](blockbook buildBtcNote,ADR 0011)承载)。

// —— 各 kind schema(connector 组合子集用) ——
// spot:零 typed meta(普通代币行,value/渲染即全部)。
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

// 全集判别联合 —— 聚合/读端消费的完备 Balance(4-kind)。
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
