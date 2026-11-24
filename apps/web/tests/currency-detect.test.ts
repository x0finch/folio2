import { describe, expect, it } from "vitest";
import { resolveCurrency } from "@/lib/server/preferences/currency-detect";

// The currency code comes from the browser (user-editable input), so the server still validates it.
describe("resolveCurrency", () => {
  it("supported currency → its descriptor", () => {
    expect(resolveCurrency("EUR").code).toBe("EUR");
  });

  it("unsupported / empty / null → falls back to the default, no error", () => {
    // User-editable input: nothing may throw, and garbage must not pass through.
    expect(resolveCurrency("DOGE").code).toBe("USD");
    expect(resolveCurrency("")).toEqual(resolveCurrency(null));
    expect(resolveCurrency(undefined).code).toBe("USD");
  });

  it("overlong garbage string → also falls back to the default", () => {
    expect(resolveCurrency("x".repeat(4096)).code).toBe("USD");
  });
});
