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
  // 不在此持有 groupId:账户↔组是多对多,关系由 account_groups 关联表承载。
  // 账户的全部录入(凭据 + manual 持仓)统一走 provider.inputs → creds(见 ProviderInput / @folio/balances-basic creds.ts);
  // Account 上不再挂 data/has* 标志(P6.6.2 删除 AccountData;manual 持仓即三个 public 输入)。
}

export type BalanceKind = "spot" | "defi" | "perp" | "manual";

// 【净值不变量 —— 全 provider 必守约定】(仓位模型加固,路线①)
// 账户净值 totalUsd === Σ balances.usdValue;其中 usdValue = 该仓位对组合净值的【带符号净贡献】:
//   · 负债记负值(借 1000U → -1000);
//   · 每个经济仓位【只有一行承载价值】,会被拆开重复计的其余行记 usdValue:0
//     (如 perp 权益行带值、多空仓位行 0;LP 整池带值、底层币 0)。
// 这样异构仓位也能在账户层、组合层正确相加。(当前各交易所 provider 只拉单一钱包,尚不区分
// spot/funding/earn 子账户;将来接入多钱包时用 meta 区分,不影响加总。)
// usdValue 只够【加总】;各仓位的【展示】细节放 meta,按 kind 用下方 typed meta 家族窄化。
export interface Balance {
  symbol: string;
  amount: number;
  price?: number; // 单价(USD),provider 直接给则带(Zerion attributes.price / CoinStats price / manual 单价);无则省略
  value: number; // USD 价值(加总权威;原 usdValue)。sync 写快照时映射到 db 的 usdValue,不动表结构
  kind: BalanceKind;
  // 代币寻址标识(代币参考层的索引键,见 token-key.ts):带命名空间前缀的字符串,用来定位
  // "这是哪个代币",跨多种寻址方案 —— 不限链上:
  //   · 链寻址:eip155:<chainId>/erc20:<addr> | chain:<slug>/token:<addr> | native
  //   · 厂商寻址:coingecko:<coin-id>(manual 选币等已知 CGK id 时)
  // provider 在解析时按能拿到的最强寻址产出:EVM(Zerion)始终产规范 eip155:<chainId>/erc20:<addr>
  // ——拿不到数字 chainId 时直接抛错、整轮同步失败重试,绝不产分叉的 chain:<slug> 兜底形;
  // chain:<slug>/token:<addr> 只用于无 eip155 语义的非 EVM 链(CoinStats 的 Solana/Sui/Cosmos)。
  // 拿不到任何可寻址标识的行(CEX/perp 只有 symbol、无合约/无 CGK id)为 undefined → 解析时退化到按 symbol 归一。
  tokenKey?: string;
  // provider 自带的代币元信息(有则带):同步时喂参考层(noteProviderAssets),
  // 作 CGK 未收录币的展示数据与备用 logo。不落快照行(参考层是其 home)。
  name?: string;
  logo?: string;
  meta?: Record<string, unknown>; // 按 kind 的 typed meta(PerpMeta / DefiMeta / …)
}

// perp(kind:"perp")账户的 meta 共享契约。Balance.meta 仍是通用容器(各 kind 自用),
// 但永续这一类的 meta 形状在此【一处定义】:provider 生产端按它标注(编译期校验)、
// 消费端(总览展示)窄化到它,避免两端 stringly-typed key 漂移(契约优先,原则 #1)。
// 永续是杠杆敞口:账户净值由 equity 行承载(usdValue=accountValue),仓位行 usdValue=0、
// 明细在此 meta 里(见 @folio/balances-provider-hyperliquid 与 P5.1 决策)。
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
// chain/合约不再进 meta —— 身份走 Balance.tokenKey(CAIP-19);meta 只留展示所需。
export interface DefiMeta {
  protocol?: string;
  positionType?: string;
}

// bitcoin(kind:"spot",tokenKey chain:bitcoin/native:btc)的 meta 共享契约。
// provider(@folio/provider-bitcoin)生产、app(account-view/holdings)消费,两端窄化到此,避免 key 漂移。
// 值不变量照旧:Balance.amount/value = 已确认(≥1 确认);未确认(mempool)只在此 meta 里(pendingSats),
// 可被 RBF/丢弃,不进权威值。xpub 模式额外带派生地址分布 + 收款地址指引。
export interface BitcoinAddress {
  address: string;
  path: string; // 派生路径 m/purpose'/0'/0'/chain/index
  chain: "receive" | "change"; // 外部收款链 / 找零链
  balanceSats: number; // 已确认净额(sats)
  pendingSats: number; // 未确认净额(± sats)
}
export interface BitcoinReceive {
  lastUsed: { index: number; address: string } | null; // 外部链最大已用下标
  next: { index: number; address: string }[]; // 其后未用的头两个外部地址
}
export interface BitcoinMeta {
  pendingSats: number; // 账户净未确认(± mempool);两模式都填
  addresses?: BitcoinAddress[]; // xpub:仅非零(有余额或在途)的派生地址
  receive?: BitcoinReceive; // xpub:收款地址指引
  truncated?: boolean; // xpub 扫描超地址硬上限,结果不完整
}

export interface AssetSnapshot {
  accountId: string;
  takenAt: number; // epoch ms
  totalUsd: number;
  balances: Balance[];
}
