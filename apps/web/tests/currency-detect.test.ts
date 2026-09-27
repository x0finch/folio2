import { describe, expect, it } from "vitest";
import { resolveCurrency } from "@/lib/server/preferences/currency-detect";

// 币种偏好的纯逻辑半:SUPPORTED 校验。码现在是调用方(浏览器 localStorage)传来的参数,
// 同样是用户可改的输入 —— 这一关仍在服务端守。
describe("resolveCurrency", () => {
  it("支持的币种 → 那个描述符", () => {
    expect(resolveCurrency("EUR").code).toBe("EUR");
  });

  it("不支持的 / 空 / null → 回落默认,不是报错", () => {
    // 码是用户可改的输入 —— 塞什么进来都不能炸,也不能把垃圾透传下去。
    expect(resolveCurrency("DOGE").code).toBe("USD");
    expect(resolveCurrency("")).toEqual(resolveCurrency(null));
    expect(resolveCurrency(undefined).code).toBe("USD");
  });

  it("超长垃圾串 → 同样回落默认", () => {
    expect(resolveCurrency("x".repeat(4096)).code).toBe("USD");
  });
});
