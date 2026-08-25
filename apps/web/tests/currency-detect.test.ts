import { describe, expect, it } from "vitest";
import {
  CURRENCY_COOKIE,
  readCurrencyCookie,
  resolveCurrency,
} from "@/lib/server/preferences/currency-detect";

// #527 后续件 1:币种偏好的纯逻辑半。它原来是 currency.ts 的私有函数 —— 那个文件在
// workers-pool 里 import 就失败,所以这些命题此前**测不了**(不是没测)。拆出来之后
// 落在 logic 组,毫秒级。
describe("readCurrencyCookie", () => {
  it("从 Cookie 头里取 folio_currency", () => {
    expect(readCurrencyCookie(`a=1; ${CURRENCY_COOKIE}=EUR; b=2`)).toBe("EUR");
  });

  it("没有 cookie 头 / 没有那个键 → undefined", () => {
    expect(readCurrencyCookie(null)).toBeUndefined();
    expect(readCurrencyCookie("a=1; b=2")).toBeUndefined();
  });

  it("值是 URL 编码的 → 解回来", () => {
    expect(readCurrencyCookie(`${CURRENCY_COOKIE}=E%55R`)).toBe("EUR");
  });

  it("值里带等号 → 只按第一个等号切", () => {
    expect(readCurrencyCookie(`${CURRENCY_COOKIE}=a=b`)).toBe("a=b");
  });
});

describe("resolveCurrency", () => {
  it("支持的币种 → 那个描述符", () => {
    expect(resolveCurrency("EUR").code).toBe("EUR");
  });

  it("不支持的 / 空 / null → 回落默认,不是报错", () => {
    // cookie 是用户可改的输入 —— 塞什么进来都不能炸,也不能把垃圾透传下去。
    expect(resolveCurrency("DOGE").code).toBe("USD");
    expect(resolveCurrency("")).toEqual(resolveCurrency(null));
    expect(resolveCurrency(undefined).code).toBe("USD");
  });

  it("超长垃圾串 → 同样回落默认", () => {
    expect(resolveCurrency("x".repeat(4096)).code).toBe("USD");
  });
});
