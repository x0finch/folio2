import type { ConnectorId } from "@folio/connectors";

// app 侧的 connector 展示元数据(下拉选项 + 展示名)。account.connectorId 的取值域即 @folio/connectors 的
// ConnectorId(registry 派生的单一事实源,#37d)。客户端只 type-only 引 ConnectorId(不把 registry 运行时
// 打进 client bundle,见 CODING #客户端打包);下方为手写字面量,不从 registry 运行时读取。

// add-account 下拉的固定分组列表 —— 直接写死(group 展示名 + 该组 connector)。
// group 仅是下拉的分区标题(纯展示),不参与任何逻辑;随 connector 增多在对应组加一项。
export const CONNECTOR_OPTIONS: { group: string; options: ConnectorId[] }[] = [
  { group: "Manual", options: ["manual"] },
  { group: "On-chain", options: ["evm", "bitcoin", "solana", "sui", "cosmos"] },
  { group: "Exchange", options: ["binance", "okx"] },
  { group: "Perp DEX", options: ["hyperliquid"] },
];
