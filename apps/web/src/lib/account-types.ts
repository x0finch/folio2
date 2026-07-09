import type { ConnectorId } from "@folio/connectors";

// account.connectorId 的取值域即 @folio/connectors 的 ConnectorId(从 registry 派生的单一事实源,#37d)。
// 客户端只 type-only 引 ConnectorId(不把 registry 运行时打进 client bundle,见 CODING #客户端打包);
// 下方 TYPE_GROUPS/TYPE_LABELS 为手写字面量(UI 展示/分组),不从 registry 运行时读取。

// 账户类型注册表:分组(Select 分组 + 账户页分区)与展示名。随 connector 增多只是多几项。
// 展示名多为专有名词(链/所/场所),不翻译;分组标题走 i18n(Accounts.cat_*)。
// 由 add-account-sheet(分组 Select)、accounts 页(徽章/分区)、account-detail-sheet 共用。
export type AccountCategory = "manual" | "onchain" | "exchange" | "perp";

export const TYPE_GROUPS: { category: AccountCategory; types: ConnectorId[] }[] = [
  { category: "manual", types: ["manual"] },
  {
    category: "onchain",
    types: ["evm", "bitcoin", "solana", "sui", "cosmos"],
  },
  { category: "exchange", types: ["binance", "okx"] },
  { category: "perp", types: ["hyperliquid"] },
];

export type OnchainType = "evm" | "bitcoin" | "solana" | "sui" | "cosmos";

export const TYPE_LABELS: Partial<Record<ConnectorId, string>> = {
  manual: "Manual",
  evm: "EVM",
  bitcoin: "Bitcoin",
  solana: "Solana",
  sui: "Sui",
  cosmos: "Cosmos",
  binance: "Binance",
  okx: "OKX",
  hyperliquid: "Hyperliquid",
};

export function typeLabel(type: ConnectorId): string {
  return TYPE_LABELS[type] ?? type;
}

const CATEGORY_BY_TYPE = new Map<ConnectorId, AccountCategory>(
  TYPE_GROUPS.flatMap((g) => g.types.map((t) => [t, g.category] as const)),
);
export function accountCategory(type: ConnectorId): AccountCategory | undefined {
  return CATEGORY_BY_TYPE.get(type);
}
