import type { ConnectorId } from "@folio/connectors";

// 连接器 → 类别的【单一事实源】。穷举 Record<ConnectorId, …> → 新增连接器若不填,此处直接编译报错。
// 两个消费者都从这里派生,不再各自硬编码名单(#52 收尾):
//   · account-types.TYPE_GROUPS —— add-account 下拉分组 + 账户页分区;
//   · aggregate.platformIdFromAccount —— 场馆持仓的平台键前缀(exchange:/perp:/chain:)。
// 纯字符串 + ConnectorId 类型(不引 registry 运行时)→ 客户端安全(区别于需 registry 的 TYPE_LABELS)。
export type AccountCategory = "manual" | "onchain" | "exchange" | "perp";

export const CONNECTOR_CATEGORY: Record<ConnectorId, AccountCategory> = {
  manual: "manual",
  evm: "onchain",
  bitcoin: "onchain",
  solana: "onchain",
  sui: "onchain",
  cosmos: "onchain",
  binance: "exchange",
  okx: "exchange",
  hyperliquid: "perp",
};

// 类别展示顺序(add-account 分组 / 分区);组内连接器顺序取 CONNECTOR_CATEGORY 的插入序。
export const CATEGORY_ORDER: readonly AccountCategory[] = ["manual", "onchain", "exchange", "perp"];

// 账户 connectorId → 类别(未知/未接线 → undefined,由调用方兜底)。
export function categoryOf(connectorId: string): AccountCategory | undefined {
  return CONNECTOR_CATEGORY[connectorId as ConnectorId];
}
