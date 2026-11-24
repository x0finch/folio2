import { FIAT_NAMER, SUPPORTED_CURRENCIES, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import type { TokenOption } from "@/lib/core/token-model";

// Data for the picker's fiat group: the `kind === "fiat"` entries of `SUPPORTED_CURRENCIES` (same set as display
// currencies). `ticket` carries `fiat/issued:<CODE>`, an opaque string the client passes through and mintHolding
// resolves on submit; the logo is the inline base64 from `SUPPORTED_CURRENCIES`; no `price` (fiat has no market
// price; getTokenPrice prefills from FX). Pure and server-consumed (`list-fiat-options.ts`): the client never builds
// tokenRefs / tickets. Names come from `Intl.DisplayNames` for the given locale, falling back to the CODE.
export function buildFiatOptions(locale: string): TokenOption[] {
  const names = new Intl.DisplayNames([locale], { type: "currency" });
  return SUPPORTED_CURRENCIES.filter((c) => c.kind === "fiat").map((c) => ({
    ticket: tokenTicket.encode(tokenRef.issued(FIAT_NAMER, c.code)),
    symbol: c.code,
    name: names.of(c.code) ?? c.code,
    logo: c.logo,
  }));
}
