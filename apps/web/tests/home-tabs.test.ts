import { describe, expect, it } from "vitest";
import { ALLOC_DIMENSION, DEFAULT_DIM } from "../src/lib/allocation";
import { kindPresence, kindTabsOf, pickShownTab, resolvePinLabel } from "../src/lib/home-tabs";

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

// #488 票 4:tab 条先于列表出现。轻请求只给两个布尔值,客户端按同一套规则排三个视角 tab。
// 顺序写死(Tokens → Perps → DeFi),和今天画面上的一样 —— 列表后到时不能再插进一个 tab。
describe("kindTabsOf —— 三个视角 tab 谁出现", () => {
  it("Tokens 恒在", () => {
    expect(kindTabsOf(false, false)).toEqual(["tokens"]);
  });

  it("有永续就挂在 Tokens 后面", () => {
    expect(kindTabsOf(true, false)).toEqual(["tokens", "perps"]);
  });

  it("有 DeFi 就挂在最后", () => {
    expect(kindTabsOf(false, true)).toEqual(["tokens", "defi"]);
  });

  it("两个都有 → Tokens / Perps / DeFi", () => {
    expect(kindTabsOf(true, true)).toEqual(["tokens", "perps", "defi"]);
  });
});

describe("kindPresence —— 和总览同一套「算不算有永续 / DeFi」", () => {
  const empty = { perp: null, defi: [] };

  it("空 sections → 两个 tab 都不出", () => {
    expect(kindPresence([empty])).toEqual({ hasPerps: false, hasDefi: false });
  });

  it("有永续权益 → 出永续 tab(哪怕没有仓位)", () => {
    expect(
      kindPresence([{ perp: { positions: [], equity: { accountValue: 100 } }, defi: [] }]),
    ).toEqual({ hasPerps: true, hasDefi: false });
  });

  it("有永续仓位 → 出永续 tab", () => {
    expect(
      kindPresence([{ perp: { positions: [{ coin: "ETH" }], equity: null }, defi: [] }]),
    ).toEqual({ hasPerps: true, hasDefi: false });
  });

  it("永续对象在但仓位空、权益空 → 不出(和总览 derive 一致)", () => {
    expect(kindPresence([{ perp: { positions: [], equity: null }, defi: [] }])).toEqual({
      hasPerps: false,
      hasDefi: false,
    });
  });

  it("有 DeFi 组 → 出 DeFi tab", () => {
    expect(
      kindPresence([
        {
          perp: null,
          defi: [{ protocol: "Aave", rows: [{ id: "1", symbol: "GHO", amount: 1, usdValue: 10 }] }],
        },
      ]),
    ).toEqual({ hasPerps: false, hasDefi: true });
  });
});

describe("resolvePinLabel —— 三种目标的显示名由服务端解析", () => {
  const lookup = {
    tagName: (id: string) => (id === "tg1" ? "DeFi" : undefined),
    accountName: (id: string) => (id === "acc1" ? "Cold" : undefined),
    connector: (id: string) =>
      id === "binance"
        ? { name: "Binance", logo: "/api/logo/platform/binance" }
        : { name: "Unknown" },
  };

  it("标签 → 名字,没有图", () => {
    expect(resolvePinLabel({ kind: "tag", tagId: "tg1" }, lookup)).toEqual({ name: "DeFi" });
  });

  it("账户 → 名字,没有图", () => {
    expect(resolvePinLabel({ kind: "account", accountId: "acc1" }, lookup)).toEqual({
      name: "Cold",
    });
  });

  it("连接器 → 类型名 + 已代理的图", () => {
    expect(resolvePinLabel({ kind: "connector", connectorId: "binance" }, lookup)).toEqual({
      name: "Binance",
      logo: "/api/logo/platform/binance",
    });
  });

  it("所指的标签已经没了 → 空名字,不炸", () => {
    expect(resolvePinLabel({ kind: "tag", tagId: "gone" }, lookup)).toEqual({ name: "" });
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
