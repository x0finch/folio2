import { parseTokenRef } from "@folio/oracle-ref";

// Platform = the tokenRef namer: the chain for on-chain holdings, the venue for CEX holdings.
export function platformOf(tokenRef: string, connectorId: string): string {
  const parsed = parseTokenRef(tokenRef);
  if (parsed.kind === "unknown") return connectorId;
  return parsed.namer;
}
