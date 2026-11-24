import { FIAT_NAMER, tokenTicket } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { buildFiatOptions } from "@/lib/server/tokens/fiat-options";

// Each option's ref must decode back to `fiat/issued:<CODE>`; mintHolding relies on it for the fiat row.

// Matches the fiat set of SUPPORTED_CURRENCIES.
const EXPECTED_CODES = ["USD", "EUR", "GBP", "JPY", "CNY", "KRW", "HKD", "CAD", "AUD", "CHF"];

describe("buildFiatOptions", () => {
  it("yields 10 fiat currencies, symbol is the ISO code", () => {
    const opts = buildFiatOptions("en");
    expect(opts.map((o) => o.symbol).sort()).toEqual([...EXPECTED_CODES].sort());
  });

  it("each has a non-empty logo (inline base64) and currency name", () => {
    for (const o of buildFiatOptions("en")) {
      expect(o.logo).toMatch(/^data:image\//);
      expect(o.name.length).toBeGreaterThan(0);
    }
  });

  it("currency name follows the locale (Intl)", () => {
    const usdEn = buildFiatOptions("en").find((o) => o.symbol === "USD");
    const usdZh = buildFiatOptions("zh").find((o) => o.symbol === "USD");
    expect(usdEn?.name).toBe("US Dollar");
    // zh name non-empty and different from en (no hard-coded translation, just "follows locale").
    expect(usdZh?.name).toBeTruthy();
    expect(usdZh?.name).not.toBe(usdEn?.name);
  });

  // Otherwise submit falls back to custom and no fiat row is created. decode takes FIAT_NAMER.
  it("ref round-trip: each decodes to fiat/issued:<CODE>", () => {
    for (const o of buildFiatOptions("en")) {
      expect(tokenTicket.decode(o.ticket, FIAT_NAMER)).toBe(`fiat/issued:${o.symbol}`);
    }
  });
});
