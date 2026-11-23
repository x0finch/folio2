import type { Balance, BalanceProvider, ConnectorManifest } from "@folio/connectors-basic";
import { binance } from "./connectors/binance";
import { bitcoin } from "./connectors/bitcoin";
import { bybit } from "./connectors/bybit";
import { cosmos } from "./connectors/cosmos";
import { evm } from "./connectors/evm";
import { hyperliquid } from "./connectors/hyperliquid";
import { manual } from "./connectors/manual";
import { okx } from "./connectors/okx";
import { solana } from "./connectors/solana";
import { sui } from "./connectors/sui";

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

// First provider not explicitly disabled, else providers[0]; undefined if there are none.
export function selectProvider(manifest: ConnectorManifest): BalanceProvider<Balance> | undefined {
  return (
    manifest.balance.providers.find((p) => p.defaultEnabled !== false) ??
    manifest.balance.providers[0]
  );
}

export const connectors = [
  evm,
  bitcoin,
  solana,
  sui,
  cosmos,
  binance,
  okx,
  bybit,
  hyperliquid,
  manual,
] as const satisfies readonly ConnectorManifest[];
export const registry: ConnectorRegistry = buildRegistry(connectors);

export type ConnectorId = (typeof connectors)[number]["id"];
