// WebAuthn RP params derive from BETTER_AUTH_URL: rpID = host (no protocol / port), origin = full origin
// (must match the browser's).

export const RP_NAME = "Folio";

export interface PasskeyRp {
  rpID: string;
  rpName: string;
  origin: string;
}

export function derivePasskeyRp(baseUrl: string): PasskeyRp {
  const url = new URL(baseUrl);
  return { rpID: url.hostname, rpName: RP_NAME, origin: url.origin };
}
