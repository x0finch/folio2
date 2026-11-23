import { describe, expect, it } from "vitest";
import { coinGeckoConfigOf } from "@/lib/server/coingecko-config";

describe("coinGeckoConfigOf", () => {
  it("nothing set → both default (official free base URL, no key)", () => {
    expect(coinGeckoConfigOf({})).toEqual({ apiKey: undefined, baseUrl: undefined });
  });

  it("empty string counts as unset — a bare `COINGECKO_API_BASE=` in .dev.vars must not target an empty base", () => {
    expect(coinGeckoConfigOf({ COINGECKO_API_KEY: "", COINGECKO_API_BASE: "  " })).toEqual({
      apiKey: undefined,
      baseUrl: undefined,
    });
  });

  it("base set → passed to the client as-is (trimmed)", () => {
    expect(
      coinGeckoConfigOf({
        COINGECKO_API_KEY: "k",
        COINGECKO_API_BASE: " http://127.0.0.1:3399/cg ",
      }),
    ).toEqual({ apiKey: "k", baseUrl: "http://127.0.0.1:3399/cg" });
  });
});
