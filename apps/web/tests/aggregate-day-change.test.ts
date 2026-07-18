import { describe, expect, it } from "vitest";
import { aggregateDayChange } from "../src/lib/day-value-change";

// 一组持仓行的 24h 增值聚合(全站统一:协议行 / 账户行共用)。
// delta = Σ 单行 dayValueChange;pct 分母 = 总敞口前值 Σ|前值|(缺 change24h 的行按现值计入)。
describe("aggregateDayChange", () => {
  it("多行:delta = Σ 单行增值,pct 相对总敞口前值", () => {
    // 10100 涨 1% → +100(前值 10000);-5000 缺 change24h → 不计 delta,但 |−5000| 计入分母
    const c = aggregateDayChange([{ usdValue: 10100, change24h: 1 }, { usdValue: -5000 }]);
    expect(c?.delta).toBeCloseTo(100, 6);
    expect(c?.pct).toBeCloseTo((100 / 15000) * 100, 3);
  });

  it("负值行升值 → 负贡献,pct 相对 |前值|", () => {
    // -20400 涨 2% → 前值 -20000,增值 -400
    const c = aggregateDayChange([{ usdValue: -20400, change24h: 2 }]);
    expect(c?.delta).toBeCloseTo(-400, 6);
    expect(c?.pct).toBeCloseTo(-2, 6);
  });

  it("无一行带 change24h → null(不显增量)", () => {
    expect(aggregateDayChange([{ usdValue: 100 }, { usdValue: -50 }])).toBeNull();
  });

  it("空 → null", () => {
    expect(aggregateDayChange([])).toBeNull();
  });
});
