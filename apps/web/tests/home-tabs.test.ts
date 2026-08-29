import { describe, expect, it } from "vitest";
import { kindPresence, resolvePinLabel } from "@/lib/core/portfolio";
import { kindTabsOf, pickShownTab, tabAfterUnpin } from "@/routes/_authed/-home/home-tabs";

// 页内 tab 进 URL(片5 / ADR 0043)。URL 是外面来的,所以「认不出的值怎么办」是这一片的正经逻辑,
// 不是边角情况:pin 被删之后旧链接就指向一个不存在的 tab。

describe("pickShownTab —— 首页主 tab 的回落", () => {
  // 首页的合法值含运行时的 pin id,route 的 `validateSearch` 判不了,所以回落在组件侧,由这个
  // 纯函数承担 —— 不能从 `tab/selection.ts` import(那会拉进 getRouteApi / cloudflare:workers)。
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

describe("tabAfterUnpin —— 取消当前 pin 回左邻,不滑回 Tokens", () => {
  const pins = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const kinds = kindTabsOf(true, false); // tokens, perps

  it("中间 / 末尾 → 前一个 pin", () => {
    expect(tabAfterUnpin("b", pins, kinds)).toBe("a");
    expect(tabAfterUnpin("c", pins, kinds)).toBe("b");
  });

  it("第一个 pin → 最后一个视角 tab,不是 Tokens", () => {
    expect(tabAfterUnpin("a", pins, kinds)).toBe("perps");
  });

  it("只有 Tokens 视角时,第一个 pin 才回 Tokens", () => {
    expect(tabAfterUnpin("a", [{ id: "a" }], kindTabsOf(false, false))).toBe("tokens");
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
