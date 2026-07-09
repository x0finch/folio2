import type { ConnectorId } from "@folio/connectors";
import {
  type AccountCategory,
  CATEGORY_ORDER,
  CONNECTOR_CATEGORY,
  categoryOf,
} from "./connector-category";

// account.connectorId 的取值域即 @folio/connectors 的 ConnectorId(从 registry 派生的单一事实源,#37d)。
// 客户端只 type-only 引 ConnectorId(不把 registry 运行时打进 client bundle,见 CODING #客户端打包)。
// 分组(TYPE_GROUPS)与类别(accountCategory)从 CONNECTOR_CATEGORY 派生(单一事实源,与 aggregate 同表)。
// TYPE_LABELS 仍是手写字面量(= connector.label 的副本;消它需 registry 运行时 → 客户端顾虑,留 #52)。
export type { AccountCategory };

// 分组:按 CATEGORY_ORDER 展示,组内取 CONNECTOR_CATEGORY 的插入序。
// 由 add-account-sheet(分组 Select)、accounts 页(徽章/分区)、account-detail-sheet 共用。
const CONNECTOR_IDS = Object.keys(CONNECTOR_CATEGORY) as ConnectorId[];
export const TYPE_GROUPS: { category: AccountCategory; types: ConnectorId[] }[] =
  CATEGORY_ORDER.map((category) => ({
    category,
    types: CONNECTOR_IDS.filter((id) => CONNECTOR_CATEGORY[id] === category),
  }));

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

export function accountCategory(type: ConnectorId): AccountCategory | undefined {
  return categoryOf(type);
}
