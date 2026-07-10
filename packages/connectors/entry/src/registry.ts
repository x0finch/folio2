import type { Balance, BalanceProvider, ConnectorManifest } from "@folio/connectors-basic";
import { binance } from "./connectors/binance";
import { bitcoin } from "./connectors/bitcoin";
import { cosmos } from "./connectors/cosmos";
import { evm } from "./connectors/evm";
import { hyperliquid } from "./connectors/hyperliquid";
import { manual } from "./connectors/manual";
import { okx } from "./connectors/okx";
import { solana } from "./connectors/solana";
import { sui } from "./connectors/sui";

// connectorId → manifest 的登记表。每个 connector 自带 providers → 无全局 provider 汤、无按 type 去重。
export type ConnectorRegistry = ReadonlyMap<string, ConnectorManifest>;

export function buildRegistry(manifests: readonly ConnectorManifest[]): ConnectorRegistry {
  const map = new Map<string, ConnectorManifest>();
  for (const m of manifests) {
    if (map.has(m.id)) throw new Error(`duplicate connector id: ${m.id}`);
    map.set(m.id, m);
  }
  return map;
}

export function getConnector(
  registry: ConnectorRegistry,
  id: string,
): ConnectorManifest | undefined {
  return registry.get(id);
}

// 取数选第一个 eligible provider(defaultEnabled !== false),否则退化到 providers[0]。
// 运行时"选/配 provider"机制延后(ADR 决策 #8)。空 providers → undefined。
export function selectProvider(manifest: ConnectorManifest): BalanceProvider<Balance> | undefined {
  return (
    manifest.balance.providers.find((p) => p.defaultEnabled !== false) ??
    manifest.balance.providers[0]
  );
}

// 全部 connector 在此登记(各 connector 文件逐个填入)。#31:evm(zerion);#32:bitcoin(blockbook);
// #33:solana/sui/cosmos(coinstats —— 一个 provider 包服务三个 connector);#34:binance/okx(CEX);
// #35:hyperliquid(唯一的多 kind connector,吐 perp_equity + perp_position)。
// #36:manual(custom —— 手动资产,无外部 API,单 kind:spot,零 typed meta)。全 9 个 connector 齐备。
export const connectors = [
  evm,
  bitcoin,
  solana,
  sui,
  cosmos,
  binance,
  okx,
  hyperliquid,
  manual,
] as const satisfies readonly ConnectorManifest[];
export const registry: ConnectorRegistry = buildRegistry(connectors);

// connectorId 事实源(#37d):从 connectors 数组的 id 派生的字面量联合
// = "evm"|"bitcoin"|"solana"|"sui"|"cosmos"|"binance"|"okx"|"hyperliquid"|"manual"。
// db 的 account.connectorId 列类型与 app 的 ConnectorId 标注皆取自此单一事实源。
export type ConnectorId = (typeof connectors)[number]["id"];
