import { describe, expect, it } from "vitest";
import { valuate } from "../src/valuate";

// Valuation priority truth table; amount=10 fixed, checks unit selection + value=amount x unit.
describe("valuate", () => {
  describe("self-first (default)", () => {
    it("own price + source price: uses own", () => {
      expect(valuate(10, 2, 3, "self-first")).toEqual({ unitPrice: 2, value: 20 });
    });
    it("no own price: source fills in", () => {
      expect(valuate(10, undefined, 3, "self-first")).toEqual({ unitPrice: 3, value: 30 });
    });
    it("own price, no source price: uses own", () => {
      expect(valuate(10, 2, undefined, "self-first")).toEqual({ unitPrice: 2, value: 20 });
    });
    it("neither: undefined (the caller keeps the original value)", () => {
      expect(valuate(10, undefined, undefined, "self-first")).toBeUndefined();
    });
  });

  describe("source-first (switch on)", () => {
    it("source price + own price: uses source", () => {
      expect(valuate(10, 2, 3, "source-first")).toEqual({ unitPrice: 3, value: 30 });
    });
    it("no source price: own as fallback", () => {
      expect(valuate(10, 2, undefined, "source-first")).toEqual({ unitPrice: 2, value: 20 });
    });
    it("source price, no own: uses source", () => {
      expect(valuate(10, undefined, 3, "source-first")).toEqual({ unitPrice: 3, value: 30 });
    });
    it("neither: undefined", () => {
      expect(valuate(10, undefined, undefined, "source-first")).toBeUndefined();
    });
  });

  it("unit=0 counts as a value (not missing)", () => {
    // 0 is a legal price (e.g. a token whose depth went to zero); `??` falls back only for null/undefined, not 0.
    expect(valuate(10, 0, 5, "self-first")).toEqual({ unitPrice: 0, value: 0 });
  });
});
