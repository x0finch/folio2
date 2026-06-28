import type { CredentialFlags } from "./provider";

// AccountType 自包含:看值即知具体账户,无需再读 provider 字段。
// 命名口径:<类别>_<具体>。链上按"生态"分(具体 EVM 链放 network 字段),
// 交易所/永续到具体机构,manual 单列。
// UI 分组用 type.split("_")[0] 即可拿到类别(onchain / exchange / perp / manual)。
export type AccountType =
  // 链上(按生态分;具体 EVM 链放 network 字段)
  | "onchain_evm"
  | "onchain_solana"
  | "onchain_sui"
  | "onchain_cosmos"
  | "onchain_bitcoin" // xpub 或单地址
  // 中心化交易所
  | "exchange_binance"
  | "exchange_okx"
  | "exchange_bybit"
  | "exchange_bitget"
  | "exchange_gate"
  // 永续 DEX
  | "perp_hyperliquid"
  | "perp_derive"
  | "perp_extended"
  // 手动
  | "manual";

export interface Account {
  id: string;
  userId: string;
  // 自包含,决定派哪个 provider(经注册表),不再单存 provider 字段。
  type: AccountType;
  // 仅 onchain_evm 等需要:具体链,如 "ethereum" | "arbitrum" | "base"。
  network?: string;
  label: string;
  // 按账户类型的额外数据(通用容器,扩展时往 AccountData 并集加一支)。
  // manual 账户在此装手填持仓;落库时加密存(隐私)。非密钥,与 ProviderCredentials 分离。
  data?: AccountData;
  // 不在此持有 groupId:账户↔组是多对多,关系由 account_groups 关联表承载。
  // 凭据本身不返回,只返回每个凭据字段是否已设置的 has* 布尔(见 AccountWithFlags)。
}

// 实际对外的账户类型 = 基础字段 + 由 ProviderCredentials 推导出的 has* 标志。
// 给凭据加字段时这里自动多一个,不会两边不同步(见 provider.ts 的 CredentialFlags)。
export type AccountWithFlags = Account & CredentialFlags;

export type BalanceKind = "spot" | "defi" | "perp" | "manual";

// 【净值不变量 —— 全 provider 必守约定】(仓位模型加固,路线①)
// 账户净值 totalUsd === Σ balances.usdValue;其中 usdValue = 该仓位对组合净值的【带符号净贡献】:
//   · 负债记负值(借 1000U → -1000);
//   · 每个经济仓位【只有一行承载价值】,会被拆开重复计的其余行记 usdValue:0
//     (如 perp 权益行带值、多空仓位行 0;LP 整池带值、底层币 0)。
// 这样异构仓位也能在账户层、组合层正确相加。子账户(spot/funding/earn)用 source 区分,不影响加总。
// usdValue 只够【加总】;各仓位的【展示】细节放 meta,按 kind 用下方 typed meta 家族窄化。
export interface Balance {
  symbol: string;
  amount: number;
  usdValue: number;
  source: string; // 来源标注(子账户 / 协议 / 链等)
  kind: BalanceKind;
  meta?: Record<string, unknown>; // 按 kind 的 typed meta(PerpMeta / DefiMeta / …)
}

// perp(kind:"perp")账户的 meta 共享契约。Balance.meta 仍是通用容器(各 kind 自用),
// 但永续这一类的 meta 形状在此【一处定义】:provider 生产端按它标注(编译期校验)、
// 消费端(总览展示)窄化到它,避免两端 stringly-typed key 漂移(契约优先,原则 #1)。
// 永续是杠杆敞口:账户净值由 equity 行承载(usdValue=accountValue),仓位行 usdValue=0、
// 明细在此 meta 里(见 @folio/provider-hyperliquid 与 P5.1 决策)。
export interface PerpEquityMeta {
  role: "equity";
  withdrawable: number;
  totalMarginUsed: number;
  totalNtlPos: number;
}
export interface PerpPositionMeta {
  role: "position";
  side: "long" | "short";
  entryPx: number;
  positionValue: number; // 名义敞口 USD(非净值贡献)
  unrealizedPnl: number;
  leverage?: number;
  leverageType?: string;
  liquidationPx: number | null;
  marginUsed: number;
}
export type PerpMeta = PerpEquityMeta | PerpPositionMeta;

// defi(kind:"defi")仓位的 meta 共享契约(锚定 zerion 现有输出)。consumer(总览 DeFi 分区)
// 据此窄化、按 protocol 分组展示。positionType 暂用 provider 原始词汇(staked/deposit/loan…),
// 统一归一化枚举与各类细节字段(借贷健康度、LP 底层币等)留各 provider 落地时逐个填。
export interface DefiMeta {
  chain?: string;
  protocol?: string;
  positionType?: string;
}

export interface AssetSnapshot {
  accountId: string;
  takenAt: number; // epoch ms
  totalUsd: number;
  balances: Balance[];
}

// manual 账户的单条手填持仓:数量与美元价值由用户录入(自动定价为后续增强)。
export interface ManualHolding {
  symbol: string;
  amount: number;
  usdValue: number;
}

// manual 账户的 data 载荷。
export interface ManualData {
  holdings: ManualHolding[];
}

// Account.data 的并集:每新增一种带额外数据的账户类型,在此加一支。
export type AccountData = ManualData;
