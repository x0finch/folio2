import { describe, expect, it } from "vitest";
import {
  attachHoldingGains,
  attachSectionGains,
  defiGainKey,
  type PortfolioGains,
} from "../src/lib/gain-merge";

// 24h 盈亏另走一条读(#488)之后,贴回各行这一步的钉子。**它最容易错的不是算错,是键对不上** ——
// 键错了不报错,只表现为「这一行永远没有涨跌」,和「这行算不出」在界面上长得一模一样。

const gain = (amount: number) => ({ amount, pct: null, segments: [] });

const gains: PortfolioGains = {
  portfolio: gain(10),
  byKey: { "tok-1": gain(3), "tok-2": null },
  defiByKey: { [defiGainKey("acc-1", "aave")]: { amount: 2, pct: null, grossBasis: 100 } },
};

describe("盈亏贴回", () => {
  it("按持仓键贴回;查不到的行按「算不出」处理", () => {
    const out = attachHoldingGains([{ key: "tok-1" }, { key: "tok-2" }, { key: "tok-3" }], gains);

    expect(out[0].gain24h).toEqual(gain(3));
    expect(out[1].gain24h).toBeNull(); // 服务端明说算不出
    expect(out[2].gain24h).toBeNull(); // 服务端压根没提到它 —— 同样是「没有这个数」
  });

  // 盈亏那条读还没回来时,字段必须**缺席**而不是 null:界面据此画骨架而不是破折号,
  // 「还在算」与「算不出」混掉的话,页面会先断言算不出、几百毫秒后又冒出一个数。
  it("盈亏还没到 → 不写这个字段", () => {
    const out = attachHoldingGains([{ key: "tok-1" }], undefined);

    expect(out[0]).not.toHaveProperty("gain24h");
  });

  it("DeFi 按 (账户 × 协议) 贴回,分母一并带过去", () => {
    const sections = [
      { account: { id: "acc-1" }, defi: [{ protocol: "aave" }, { protocol: "compound" }] },
    ];

    const out = attachSectionGains(sections, gains);

    expect(out[0].defi[0]).toMatchObject({ gain24h: { amount: 2, grossBasis: 100 } });
    expect(out[0].defi[1]).toMatchObject({ gain24h: null });
  });

  it("同一个协议在不同账户下互不串味", () => {
    const sections = [
      { account: { id: "acc-1" }, defi: [{ protocol: "aave" }] },
      { account: { id: "acc-2" }, defi: [{ protocol: "aave" }] },
    ];

    const out = attachSectionGains(sections, gains);

    expect(out[0].defi[0].gain24h).not.toBeNull();
    expect(out[1].defi[0].gain24h).toBeNull();
  });
});
