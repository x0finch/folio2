import { describe, expect, it } from "vitest";
import { valuate } from "../src/valuate";

// 估值优先级真值表(Phase 3)。amount=10 固定,验 unit 选取 + value=amount×unit。
describe("valuate", () => {
  describe("self-first(默认)", () => {
    it("有自带价 + 有源价 → 用自带", () => {
      expect(valuate(10, 2, 3, "self-first")).toEqual({ unitPrice: 2, value: 20 });
    });
    it("无自带价 → 源价补", () => {
      expect(valuate(10, undefined, 3, "self-first")).toEqual({ unitPrice: 3, value: 30 });
    });
    it("有自带价、无源价 → 用自带", () => {
      expect(valuate(10, 2, undefined, "self-first")).toEqual({ unitPrice: 2, value: 20 });
    });
    it("都无 → undefined(调用方保留原值)", () => {
      expect(valuate(10, undefined, undefined, "self-first")).toBeUndefined();
    });
  });

  describe("source-first(开关开启)", () => {
    it("有源价 + 有自带价 → 用源", () => {
      expect(valuate(10, 2, 3, "source-first")).toEqual({ unitPrice: 3, value: 30 });
    });
    it("无源价 → 自带兜底", () => {
      expect(valuate(10, 2, undefined, "source-first")).toEqual({ unitPrice: 2, value: 20 });
    });
    it("有源价、无自带 → 用源", () => {
      expect(valuate(10, undefined, 3, "source-first")).toEqual({ unitPrice: 3, value: 30 });
    });
    it("都无 → undefined", () => {
      expect(valuate(10, undefined, undefined, "source-first")).toBeUndefined();
    });
  });

  it("unit=0 视为有值(不当缺失)", () => {
    // 0 是合法价(如深度归零的币);?? 只对 null/undefined 兜底,不对 0。
    expect(valuate(10, 0, 5, "self-first")).toEqual({ unitPrice: 0, value: 0 });
  });
});
