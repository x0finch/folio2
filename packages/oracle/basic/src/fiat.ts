import { parseTokenRef, type TokenRef } from "@folio/oracle-ref";
import { SUPPORTED_CURRENCIES } from "./fx";
import type { ProviderTokenSeed } from "./types";

// Fiat identity: a fiat tokenRef is `fiat/issued:<CODE>` (namer `fiat` vouches for ISO codes), not the unbacked hand-typed `custom:`.
// Scoped to `kind === "fiat"` entries of `SUPPORTED_CURRENCIES`; any other `fiat/issued:XXX` is unknown and gets no canonical row.
// Answers two things: whether a ref is a whitelisted fiat and its code (`fiatCodeOf`), and the seed for a canonical fiat row
// (`fiatSeed`); the logo comes from `SUPPORTED_CURRENCIES`' inline base64.

export const FIAT_NAMER = "fiat";

const FIAT_BY_CODE = new Map(
  SUPPORTED_CURRENCIES.filter((c) => c.kind === "fiat").map((c) => [c.code, c] as const),
);

// Seed of a canonical fiat row: `symbol=CODE`, logo from the inline base64; undefined outside the whitelist.
// The logo goes in `providerLogo`: fiat has no upstream canonical image, and `refreshStaleInfo` never overwrites it (fiat rows have no ref).
export function fiatSeed(code: string): ProviderTokenSeed | undefined {
  const cur = FIAT_BY_CODE.get(code.trim().toUpperCase());
  return cur ? { symbol: cur.code, providerLogo: cur.logo } : undefined;
}

// The CODE (uppercase) of a whitelisted fiat ref, else undefined. The namer must be `fiat`, the `issued:` branch, and the code whitelisted.
export function fiatCodeOf(ref: TokenRef): string | undefined {
  const parsed = parseTokenRef(ref);
  if (parsed.kind !== "issued" || parsed.namer !== FIAT_NAMER) return undefined;
  const code = parsed.id.toUpperCase();
  return FIAT_BY_CODE.has(code) ? code : undefined;
}
