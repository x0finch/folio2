import { describe, expect, it } from "vitest";
import {
  type DerivableActivity,
  deriveAmount,
  fallbackUnitPrice,
  projectToken,
} from "../src/lib/manual-activity";

const a = (
  kind: DerivableActivity["kind"],
  amount: number,
  occurredAt: number,
  createdAt = 0,
): DerivableActivity => ({ kind, amount, occurredAt, createdAt });

describe("deriveAmount", () => {
  it("empty → 0", () => {
    expect(deriveAmount([])).toBe(0);
  });

  it("no set → baseline 0 + deltas", () => {
    expect(deriveAmount([a("add", 5, 1), a("add", 3, 2), a("reduce", 2, 3)])).toBe(6);
  });

  it("set resets baseline (prior activity ignored), then deltas apply", () => {
    expect(deriveAmount([a("add", 5, 1), a("set", 10, 2), a("add", 2, 3)])).toBe(12);
  });

  it("last set wins among multiple sets", () => {
    expect(deriveAmount([a("set", 10, 1), a("add", 5, 2), a("set", 3, 3)])).toBe(3);
  });

  it("clamps at 0 (reduce more than held)", () => {
    expect(deriveAmount([a("add", 5, 1), a("reduce", 10, 2)])).toBe(0);
  });

  it("每步夹 0:中途超卖归零、不产生负债带到后续(删除更早开仓后的场景)", () => {
    // add1 → reduce2(超卖,归 0)→ add1 ⇒ 1;而非末值夹 0 的 (1−2+1)=0。
    // 即用户删掉开仓 set 后剩 add1/reduce2/add1 的原景。
    expect(deriveAmount([a("add", 1, 1), a("reduce", 2, 2), a("add", 1, 3)])).toBe(1);
  });

  it("超卖归零后再买入从 0 起算(不倒扣)", () => {
    expect(deriveAmount([a("set", 10, 1), a("reduce", 15, 2), a("add", 3, 3)])).toBe(3);
  });

  it("orders by occurredAt then createdAt (insertion order tiebreak)", () => {
    // same occurredAt: set(createdAt 1) then add(createdAt 2) → 10 + 1 = 11
    expect(deriveAmount([a("add", 1, 5, 2), a("set", 10, 5, 1)])).toBe(11);
  });
});

// projectToken:token 定义 + 活动账本 → creds.tokens 的一项(物化投影,ADR 0017)。
describe("projectToken", () => {
  it("amount = deriveAmount(activities);没带价的活动 → fallbackPrice 为 null", () => {
    const t = projectToken({ id: "tk1", symbol: "BTC" }, [a("set", 1, 1), a("add", 0.5, 2)]);
    expect(t).toEqual({ id: "tk1", symbol: "BTC", amount: 1.5, fallbackPrice: null, ref: null });
  });

  // ref 原样搬运 —— 本模块不看里面写了什么(命名者是谁、id 长什么样都不是它的事)。
  it("carries the ref through untouched", () => {
    const t = projectToken({ id: "tk1", symbol: "BTC", ref: "src/issued:bitcoin" }, [
      a("set", 2, 1),
    ]);
    expect(t).toEqual({
      id: "tk1",
      symbol: "BTC",
      amount: 2,
      fallbackPrice: null,
      ref: "src/issued:bitcoin",
    });
  });

  it("no ref (that namer hasn't identified it) → null, never undefined", () => {
    const t = projectToken({ id: "tk9", symbol: "FOO", ref: null }, []);
    expect(t).toEqual({ id: "tk9", symbol: "FOO", amount: 0, fallbackPrice: null, ref: null });
  });
});

// **自定义币怎么定价** —— 声明优先,再退到账本。与历史曲线那条链顺序相反,那是故意的
// (曲线在过去的点上账本优先;当下值必须让编辑表单说得上话)。见 fallbackUnitPrice 的注释。
describe("fallbackUnitPrice", () => {
  const priced = (price: number | null, occurredAt: number, createdAt = 1) => ({
    ...a("add", 1, occurredAt, createdAt),
    price,
  });

  it("取账本里最近一条记了价的活动", () => {
    expect(fallbackUnitPrice([priced(888, 10), priced(999, 20)])).toBe(999);
  });

  // 开仓价现在也是账本的一笔(加账户表单填的那个),所以「最新」天然包含它。
  it("只有开仓那一笔 → 就用它", () => {
    expect(fallbackUnitPrice([priced(777, 10)])).toBe(777);
  });

  it("没记价的活动不参与(price 为空的跳过)", () => {
    expect(fallbackUnitPrice([priced(null, 30), priced(888, 10)])).toBe(888);
  });

  it("同一时刻两笔 → 后录的那笔胜出(与折叠数量同口径)", () => {
    expect(fallbackUnitPrice([priced(1, 10, 1), priced(2, 10, 2)])).toBe(2);
  });

  it("一笔带价的都没有 → null(展示层据此显示无价,而不是 $0 的假确定)", () => {
    expect(fallbackUnitPrice([])).toBeNull();
    expect(fallbackUnitPrice([priced(null, 10)])).toBeNull();
  });
});
