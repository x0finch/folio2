import { FIAT_NAMER, tokenTicket } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { buildFiatOptions } from "@/lib/server/tokens/fiat-options";

// 选币下拉「法币」组的数据构建(#272)。纯函数,不出网、无 per-user —— 只验形状 + 关键校验点:
// 每张票能解回 `fiat/issued:<CODE>`(mintHolding 就靠这条建 canonical 法币行)。

// 范围锁 SUPPORTED_CURRENCIES 的 fiat 集(ADR 0025:USD/EUR/GBP/JPY/CNY/KRW/HKD/CAD/AUD/CHF)。
const EXPECTED_CODES = ["USD", "EUR", "GBP", "JPY", "CNY", "KRW", "HKD", "CAD", "AUD", "CHF"];

describe("buildFiatOptions", () => {
  it("产出 10 种法币,symbol 是 ISO 码", () => {
    const opts = buildFiatOptions("en");
    expect(opts.map((o) => o.symbol).sort()).toEqual([...EXPECTED_CODES].sort());
  });

  it("每项都有非空 logo(内嵌 base64,#268)与货币名", () => {
    for (const o of buildFiatOptions("en")) {
      expect(o.logo).toMatch(/^data:image\//);
      expect(o.name.length).toBeGreaterThan(0);
    }
  });

  it("货币名随 locale(Intl)", () => {
    const usdEn = buildFiatOptions("en").find((o) => o.symbol === "USD");
    const usdZh = buildFiatOptions("zh").find((o) => o.symbol === "USD");
    expect(usdEn?.name).toBe("US Dollar");
    // zh 名字非空且与 en 不同(不硬编码具体译名,只钉「跟随 locale」这件事)。
    expect(usdZh?.name).toBeTruthy();
    expect(usdZh?.name).not.toBe(usdEn?.name);
  });

  // **关键校验点**:票必须能被 mint 那条路解回 `fiat/issued:<CODE>` —— 否则提交时掉回 custom、
  // 建不出法币行。decode 收 FIAT_NAMER(mintHolding 传的命名者集合里的那一位)。
  it("票 round-trip:每张解回 fiat/issued:<CODE>", () => {
    for (const o of buildFiatOptions("en")) {
      expect(tokenTicket.decode(o.ticket, FIAT_NAMER)).toBe(`fiat/issued:${o.symbol}`);
    }
  });

  it("USD 的票精确解回 fiat/issued:USD", () => {
    const usd = buildFiatOptions("en").find((o) => o.symbol === "USD");
    expect(usd).toBeDefined();
    expect(tokenTicket.decode(usd!.ticket, FIAT_NAMER)).toBe("fiat/issued:USD");
  });
});
