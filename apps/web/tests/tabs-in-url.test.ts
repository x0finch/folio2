import { describe, expect, it } from "vitest";
import { isDimension, pickShownTab } from "../src/lib/page-tabs";

// 页内 tab 进 URL(片5 / ADR 0043)。URL 是外面来的,所以「认不出的值怎么办」是这一片的正经逻辑,
// 不是边角情况:pin 被删之后旧链接就指向一个不存在的 tab。
//
// **回落必须在组件这一侧**:实测 `@tanstack/react-router@1.170.16` 的 `validateSearch` 收窄的是
// 类型、不过滤值 —— 它对 `?dim=bogus` 返回 `{}`,`useSearch()` 照样给回 `"bogus"`。
// 所以这两个纯函数就是那道闸,值得钉住。

describe("pickShownTab —— 首页主 tab 的回落", () => {
  const known = (v: string) => ["tokens", "perps", "defi", "pin_a"].includes(v);

  it("认得出 → 就用它", () => {
    expect(pickShownTab("perps", "tokens", known)).toBe("perps");
    expect(pickShownTab("pin_a", "tokens", known)).toBe("pin_a");
  });

  it("pin 还没挂上(上一个仍有效)→ 停在上一个,别闪回第一个 tab", () => {
    expect(pickShownTab("pin_brand_new", "pin_a", known)).toBe("pin_a");
  });

  it("pin 被删 / 手写乱码,且上一个也失效 → 回落默认 tab", () => {
    expect(pickShownTab("pin_deleted", "pin_also_gone", known)).toBe("tokens");
    expect(pickShownTab("¯\\_(ツ)_/¯", "nope", known)).toBe("tokens");
  });

  it("空串也回落(URL 手改成 `?tab=`)", () => {
    expect(pickShownTab("", "", known)).toBe("tokens");
  });
});

describe("isDimension —— Insights 维度的回落判据", () => {
  it("三个合法维度认得出", () => {
    expect(isDimension("token")).toBe(true);
    expect(isDimension("chain")).toBe(true);
    expect(isDimension("account")).toBe(true);
  });

  it("别的一律不认(组件据此回落默认维度)", () => {
    expect(isDimension("bogus")).toBe(false);
    expect(isDimension("")).toBe(false);
    expect(isDimension(undefined)).toBe(false);
    expect(isDimension(42)).toBe(false);
  });
});
