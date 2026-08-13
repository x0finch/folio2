import { describe, expect, it } from "vitest";
import { ALLOC_DIMENSION, DEFAULT_DIM } from "../src/lib/allocation";
import { pickShownTab } from "../src/lib/home-tabs";

// 页内 tab 进 URL(片5 / ADR 0043)。URL 是外面来的,所以「认不出的值怎么办」是这一片的正经逻辑,
// 不是边角情况:pin 被删之后旧链接就指向一个不存在的 tab。

describe("pickShownTab —— 首页主 tab 的回落", () => {
  // 首页的合法值含运行时的 pin id,route 的 `validateSearch` 判不了,所以回落在组件侧,由这个
  // 纯函数承担 —— 它也是这个文件唯一的存在理由(从 route 文件 import 会拉进 cloudflare:workers)。
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

// Insights 的维度走的是另一条路:合法值是有限集,回落收进了 route 的 `validateSearch` —— 那里
// 直接把这份 schema 交给 router。下面钉的不是 zod 本身,而是**我们把 `.catch()` 接上了**:
// 少了它,`?dim=bogus` 会变成一个校验错误页,而不是安静地回落。
describe("维度 schema —— Insights 的 `?dim=` 就靠它回落", () => {
  const parse = (v: unknown) => ALLOC_DIMENSION.catch(DEFAULT_DIM).parse(v);

  it("三个合法维度原样通过", () => {
    expect(parse("token")).toBe("token");
    expect(parse("chain")).toBe("chain");
    expect(parse("account")).toBe("account");
  });

  it("别的一律回落默认维度(手写乱码、将来删掉的维度、根本没带)", () => {
    expect(parse("bogus")).toBe(DEFAULT_DIM);
    expect(parse("")).toBe(DEFAULT_DIM);
    expect(parse(undefined)).toBe(DEFAULT_DIM);
    expect(parse(42)).toBe(DEFAULT_DIM);
    expect(parse(["token", "chain"])).toBe(DEFAULT_DIM);
  });
});
