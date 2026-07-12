import { describe, expect, it } from "vitest";
import { defiLlamaVendor } from "../src/vendor";

describe("defiLlamaVendor", () => {
  it("id = defillama", () => {
    expect(defiLlamaVendor.id).toBe("defillama");
  });

  it("仅声明 prices 能力(身份/元信息/平台/汇率仍走 baseline)", () => {
    expect([...defiLlamaVendor.capabilities]).toEqual(["prices"]);
    expect(defiLlamaVendor.capabilities.has("prices")).toBe(true);
    expect(defiLlamaVendor.capabilities.has("tokenMeta")).toBe(false);
    expect(defiLlamaVendor.capabilities.has("platformMeta")).toBe(false);
    expect(defiLlamaVendor.capabilities.has("fxRates")).toBe(false);
  });
});
