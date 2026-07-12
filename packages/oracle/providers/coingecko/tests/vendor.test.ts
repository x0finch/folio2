import { describe, expect, it } from "vitest";
import { coinGeckoVendor } from "../src";

describe("coinGeckoVendor", () => {
  it("以 coingecko 为 id", () => {
    expect(coinGeckoVendor.id).toBe("coingecko");
  });

  it("Phase 1 声明代币面能力(prices/tokenMeta),尚未声明 platformMeta/fxRates", () => {
    expect(coinGeckoVendor.capabilities.has("prices")).toBe(true);
    expect(coinGeckoVendor.capabilities.has("tokenMeta")).toBe(true);
    // platforms/fx 折入前不声明(#72 才补),避免声明无实现的能力。
    expect(coinGeckoVendor.capabilities.has("platformMeta")).toBe(false);
    expect(coinGeckoVendor.capabilities.has("fxRates")).toBe(false);
  });
});
