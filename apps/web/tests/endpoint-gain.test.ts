import { describe, expect, it } from "vitest";
import { endpointGain } from "@/lib/core/portfolio";

// 24h 盈亏的纯口径(ADR 0050,取代 ADR 0040 的分段 TWR):**现在的值 − 24 小时前的值**。
// 金额 = 差值;百分比 = 差值 ÷ 起点(起点 ≤ 0 → null)。起点 null/undefined = 没有 24 小时前的
// 观测 → 整个 null(界面 `—`),与 `{ amount: 0 }`(算得出、没涨没跌)必须分得开。
describe("endpointGain —— 两端相减", () => {
  it("涨了 / 跌了:金额 = 差,百分比按起点算", () => {
    expect(endpointGain(100, 130)).toEqual({ amount: 30, pct: 30 });
    expect(endpointGain(200, 150)).toEqual({ amount: -50, pct: -25 });
  });

  it("起点缺(账户不满 24 小时 / 断线超 7 天)→ null,不是 0", () => {
    expect(endpointGain(null, 130)).toBeNull();
    expect(endpointGain(undefined, 130)).toBeNull();
  });

  it("算得出但没涨没跌 → { amount: 0, pct: 0 },与「算不出」分得开", () => {
    expect(endpointGain(100, 100)).toEqual({ amount: 0, pct: 0 });
  });

  it("起点 0(今天新买 / 充值)→ 金额照给,百分比 null(分母 0)", () => {
    expect(endpointGain(0, 130)).toEqual({ amount: 130, pct: null });
  });

  it("起点为负(DeFi 净负债)→ 百分比 null,金额照给", () => {
    expect(endpointGain(-50, -20)).toEqual({ amount: 30, pct: null });
  });
});
