import { describe, expect, it } from "vitest";
import { coinGeckoVendor } from "../src";

describe("coinGeckoVendor", () => {
  it("以 coingecko 为 id", () => {
    expect(coinGeckoVendor.id).toBe("coingecko");
  });

  it("platforms/fx 折入后声明全四项能力(prices/tokenMeta/platformMeta/fxRates)", () => {
    expect(coinGeckoVendor.capabilities.has("prices")).toBe(true);
    expect(coinGeckoVendor.capabilities.has("tokenMeta")).toBe(true);
    expect(coinGeckoVendor.capabilities.has("platformMeta")).toBe(true);
    expect(coinGeckoVendor.capabilities.has("fxRates")).toBe(true);
  });
});
