import { z } from "zod";
import { Note } from "./note";

// 【Balance —— 类型完备的 5-kind zod 判别联合】(ADR 0009)
// 判别式 kind = "一套独有 meta + 渲染契约"的扁平判别(非资产/链/来源)。
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
  // provider 专属【仅供展示】的 balance 级 note(note 重设计,单个 Note),挂在【这笔持仓】上:
  // CEX → 该币的锁仓/冻结(一段)。落 snapshot_balances.note(JSON),前端渲染成该行标题右侧的
  // 小 icon + hover popover。无共享逻辑读它 —— 纯展示。account 级 note(Note[])见 fetchBalances 顶层返回。
  note: Note.optional(),
});

// —— 各 kind 的 meta 契约(随 kind 精确) ——

// spot:可选的类型化【行为 meta】。**目前只有 manual connector 在用**:唯一字段 fixed —— 锁定固定值,
// revalue 据此跳过市价重估、钉死 amount × price。行为标志、不渲染(value/展示仍是普通代币行);
// 其它 spot 发射者(evm/coinstats/CEX)不带 meta。展示型自定义 meta 待 #43。
export const SpotMeta = z.object({ fixed: z.boolean().optional() });

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

// utxo:UTXO 型自托管持仓(BTC 及将来 UTXO 链)。value/amount = 已确认;未确认只在 meta。
const UtxoAddress = z.object({
  address: z.string(),
  path: z.string(), // 派生路径 m/purpose'/0'/0'/chain/index
  chain: z.enum(["receive", "change"]),
  balanceSats: z.number(),
  pendingSats: z.number(),
});
const UtxoReceive = z.object({
  lastUsed: z.object({ index: z.number(), address: z.string() }).nullable(),
  next: z.array(z.object({ index: z.number(), address: z.string() })),
});
export const UtxoMeta = z.object({
  pendingSats: z.number(), // 账户净未确认(± mempool)
  addresses: z.array(UtxoAddress).optional(), // xpub:仅非零派生地址
  receive: UtxoReceive.optional(), // xpub:收款地址指引
});

// —— 各 kind schema(connector 组合子集用) ——
// spot:不再严格无 meta —— 携一个【可选】的类型化行为 meta(当前仅 fixed);value/渲染仍是普通代币行。
// 保持类型化(不是开放 Record):meta 只放约定内的行为标志。
export const Spot = BalanceBase.extend({ kind: z.literal("spot"), meta: SpotMeta.optional() });
export const Defi = BalanceBase.extend({ kind: z.literal("defi"), meta: DefiMeta });
export const PerpEquity = BalanceBase.extend({
  kind: z.literal("perp_equity"),
  meta: PerpEquityMeta,
});
export const PerpPosition = BalanceBase.extend({
  kind: z.literal("perp_position"),
  meta: PerpPositionMeta,
});
export const Utxo = BalanceBase.extend({ kind: z.literal("utxo"), meta: UtxoMeta });

// 全集判别联合 —— 聚合/读端消费的完备 Balance。
export const Balance = z.discriminatedUnion("kind", [Spot, Defi, PerpEquity, PerpPosition, Utxo]);

export type Balance = z.infer<typeof Balance>;
export type BalanceKind = Balance["kind"];
export type Spot = z.infer<typeof Spot>;
export type Defi = z.infer<typeof Defi>;
export type PerpEquity = z.infer<typeof PerpEquity>;
export type PerpPosition = z.infer<typeof PerpPosition>;
export type Utxo = z.infer<typeof Utxo>;
export type SpotMeta = z.infer<typeof SpotMeta>;
export type DefiMeta = z.infer<typeof DefiMeta>;
export type PerpEquityMeta = z.infer<typeof PerpEquityMeta>;
export type PerpPositionMeta = z.infer<typeof PerpPositionMeta>;
export type UtxoMeta = z.infer<typeof UtxoMeta>;
export type UtxoAddress = z.infer<typeof UtxoAddress>;
export type UtxoReceive = z.infer<typeof UtxoReceive>;
