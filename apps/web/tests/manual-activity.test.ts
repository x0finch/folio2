import { describe, expect, it } from "vitest";
import {
  type DerivableActivity,
  deriveAmount,
  fallbackUnitPrice,
  type HistoryActivity,
  isReduceOversold,
  projectToken,
} from "@/lib/core/manual";
import { runningOk } from "@/lib/server/manual/batch";

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

// —— 浮点(FOL-109)——
// 账本数量是浮点累加,0.1 + 0.2 − 0.3 不是 0 而是 5.55e-17。以前读写两条路各算各的:写路径的超卖闸
// 有容差,读路径(折出数量、活动明细的「卖超」提示)没有 —— 于是卖光的币留下一行 `$0.0₁₂17` 的幽灵
// 持仓,而写路径刚放行的一笔正常卖出,明细里却被标成「卖超」。三处现在共用同一步折叠。
describe("浮点:卖光就是 0,正常卖出不算卖超", () => {
  it("买 0.1、买 0.2、卖 0.3 → 恰好 0,不留零头", () => {
    expect(deriveAmount([a("add", 0.1, 1), a("add", 0.2, 2), a("reduce", 0.3, 3)])).toBe(0);
  });

  it("买 0.3、卖 0.1、卖 0.2 → 写路径放行,明细也不标卖超", () => {
    const acts = [a("add", 0.3, 1), a("reduce", 0.1, 2), a("reduce", 0.2, 3)];
    expect(runningOk(acts)).toBe(true);
    expect(isReduceOversold(acts as HistoryActivity[], acts[2]!)).toBe(false);
    expect(deriveAmount(acts)).toBe(0);
  });

  // 容差按数量级取:上亿个的币(SHIB 这类),浮点误差本身就远大于 1e-9。
  it("大数量的币同样成立:买 123456789.123 + 0.1、卖 123456789.223 → 0", () => {
    const acts = [a("add", 123456789.123, 1), a("add", 0.1, 2), a("reduce", 123456789.223, 3)];
    expect(runningOk(acts)).toBe(true);
    expect(isReduceOversold(acts as HistoryActivity[], acts[2]!)).toBe(false);
    expect(deriveAmount(acts)).toBe(0);
  });

  it("真卖超照样认得出:持 1、卖 1.0001 → 写路径拒、明细标卖超、折出 0", () => {
    const acts = [a("add", 1, 1), a("reduce", 1.0001, 2)];
    expect(runningOk(acts)).toBe(false);
    expect(isReduceOversold(acts as HistoryActivity[], acts[1]!)).toBe(true);
    expect(deriveAmount(acts)).toBe(0);
  });

  it("没卖光的零头不被吞:持 1 个聪(1e-8 BTC)就是 1e-8", () => {
    expect(deriveAmount([a("add", 1, 1), a("reduce", 0.99999999, 2)])).toBeCloseTo(1e-8, 15);
  });

  // 不变量:**写路径放行的账本,明细里没有一笔是卖超**;而且折出来的数量不是负数、也不是一个
  // 比账本里最小那笔还小几个数量级的零头。随机生成小数账本(固定种子,可复现)来压这条。
  it("随机账本:runningOk 放行 ⇒ 每一笔都不标卖超,且数量要么 0 要么像样", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const dec = () => Math.round(rand() * 1000) / 100; // 0.00–10.00,两位小数
    let checked = 0;
    for (let n = 0; n < 2000; n++) {
      const acts: DerivableActivity[] = [];
      let held = 0;
      for (let i = 0; i < 2 + Math.floor(rand() * 8); i++) {
        // 卖出取「当前持有」里的一部分或全部,这样大多数账本是合法的。
        const sell = rand() < 0.4 && held > 0;
        const amt = sell ? (rand() < 0.5 ? held : Math.round(held * rand() * 100) / 100) : dec();
        if (amt <= 0) continue;
        acts.push(a(sell ? "reduce" : "add", amt, i + 1));
        held = sell ? held - amt : held + amt;
      }
      if (!runningOk(acts)) continue;
      checked++;
      for (const act of acts) expect(isReduceOversold(acts as HistoryActivity[], act)).toBe(false);
      const amount = deriveAmount(acts);
      expect(amount).toBeGreaterThanOrEqual(0);
      expect(amount === 0 || amount >= 1e-6).toBe(true);
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
