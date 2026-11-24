import { type Currency, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from "@folio/oracle-basic";

const BY_CODE = new Map(SUPPORTED_CURRENCIES.map((c) => [c.code, c]));
const FALLBACK = BY_CODE.get(DEFAULT_CURRENCY) as Currency;

/** Unknown / missing codes fall back to USD; the code is caller-supplied, so junk is filtered here. */
export function resolveCurrency(code: string | undefined | null): Currency {
  return (code ? BY_CODE.get(code) : undefined) ?? FALLBACK;
}
