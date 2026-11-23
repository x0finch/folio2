// Logos are always served through our own `/api/logo/...` proxy so the browser never hits a
// third-party CDN (that would leak holdings). Client-safe: no server-only imports.

// No upstream URL here on purpose: the proxy derives everything from the token id, and URLs
// bloated the payload.
interface LogoSource {
  id?: string;
  hasLogo?: boolean; // upstream has an http or data: image
}

export function tokenLogoUrl(e: LogoSource): string | undefined {
  if (e.id && e.hasLogo) return `/api/logo/token/${encodeURIComponent(e.id)}`;
  return undefined;
}

// Narrow before sending to the browser so upstream URLs never reach the payload.
export function toLogoSource(e: { id?: string; logo?: string; providerLogo?: string }): {
  id?: string;
  hasLogo: boolean;
} {
  return { id: e.id, hasLogo: !!(e.logo || e.providerLogo) };
}

// The server resolves the real URL from snapshot meta, keyed by protocol name.
export function defiLogoUrl(protocol: string, logo?: string): string | undefined {
  if (!logo) return undefined;
  return `/api/logo/defi/${encodeURIComponent(protocol)}`;
}

export function platformLogoUrl(key: string, logo?: string): string | undefined {
  if (!logo) return undefined;
  // Built-in data: URIs are served as-is: no privacy concern, and the proxy only fetches http.
  if (logo.startsWith("data:")) return logo;
  return `/api/logo/platform/${encodeURIComponent(key)}`;
}

// Display name until the connector catalog (manifest.label, the real authority) has loaded, so a
// cold first frame never shows raw ids. Acronyms duplicated on purpose; the manifest overwrites them.
const ACRONYMS: Record<string, string> = { evm: "EVM", okx: "OKX" };

export function connectorLabelFallback(connectorId: string): string {
  if (!connectorId) return connectorId;
  return ACRONYMS[connectorId] ?? connectorId.charAt(0).toUpperCase() + connectorId.slice(1);
}
