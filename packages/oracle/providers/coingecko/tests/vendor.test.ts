import { describe, expect, it } from "vitest";
import { coinGeckoVendor } from "../src";

describe("coinGeckoVendor", () => {
  it("以 coingecko 为 id", () => {
    expect(coinGeckoVendor.id).toBe("coingecko");
  });
});
