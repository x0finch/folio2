import type { AccountType } from "@folio/balances";

// 账户类型注册表:分组(Select 分组 + 账户页分区)与展示名。随 provider 增多只是多几项。
// 展示名多为专有名词(链/所/场所),不翻译;分组标题走 i18n(Accounts.cat_*)。
// 由 add-account-sheet(分组 Select)、accounts 页(徽章/分区)、account-detail-sheet 共用。
export type AccountCategory = "manual" | "onchain" | "exchange" | "perp";

export const TYPE_GROUPS: { category: AccountCategory; types: AccountType[] }[] = [
  { category: "manual", types: ["manual"] },
  {
    category: "onchain",
    types: ["onchain_evm", "onchain_solana", "onchain_sui", "onchain_cosmos"],
  },
  { category: "exchange", types: ["exchange_binance", "exchange_okx"] },
  { category: "perp", types: ["perp_hyperliquid"] },
];

export type OnchainType = "onchain_evm" | "onchain_solana" | "onchain_sui" | "onchain_cosmos";

export const TYPE_LABELS: Partial<Record<AccountType, string>> = {
  manual: "Manual",
  onchain_evm: "EVM",
  onchain_solana: "Solana",
  onchain_sui: "Sui",
  onchain_cosmos: "Cosmos",
  exchange_binance: "Binance",
  exchange_okx: "OKX",
  perp_hyperliquid: "Hyperliquid",
};

export function typeLabel(type: AccountType): string {
  return TYPE_LABELS[type] ?? type;
}

const CATEGORY_BY_TYPE = new Map<AccountType, AccountCategory>(
  TYPE_GROUPS.flatMap((g) => g.types.map((t) => [t, g.category] as const)),
);
export function accountCategory(type: AccountType): AccountCategory | undefined {
  return CATEGORY_BY_TYPE.get(type);
}
