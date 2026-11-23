import { getConnector, registry } from "@folio/connectors";

// Platform key -> the connector's own display metadata (name + logo). A venue / manual platform key is the connectorId,
// so no CoinGecko round trip. Chain keys aren't connectorIds: `getConnector` returns undefined -> null -> per-chain
// lookup. Server-only (imports registry). Manual has no logo ("" -> undefined), so the UI uses its built-in WalletIcon.
export function connectorPlatformMeta(
  key: string,
): { key: string; name: string; logo?: string } | null {
  // Non-EVM chain slugs (bitcoin, solana) usually equal a connector id and CoinGecko asset_platforms often lacks
  // their image, so borrow the connector's name + logo instead of initials. Deliberately crosses the Platform /
  // Connector granularity. evm:* / unknown slugs give null.
  const manifest = getConnector(registry, key);
  if (!manifest) return null;
  return { key, name: manifest.label, logo: manifest.logo || undefined };
}
