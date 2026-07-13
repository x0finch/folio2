import { describe, expect, it } from "vitest";
import { defiLlamaVendor } from "../src/vendor";

describe("defiLlamaVendor", () => {
  it("id = defillama", () => {
    expect(defiLlamaVendor.id).toBe("defillama");
  });
});
