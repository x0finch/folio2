import type { Balance, BalanceProvider, ConnectorManifest } from "@folio/connectors-basic";
import { bitcoin } from "./connectors/bitcoin";
import { evm } from "./connectors/evm";

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

// 全部 connector 在此登记(各 connector 文件逐个填入)。#31:evm(zerion);#32:bitcoin(blockbook)。
export const connectors: readonly ConnectorManifest[] = [evm, bitcoin];
export const registry: ConnectorRegistry = buildRegistry(connectors);
