import { describe, expect, it } from "vitest";
import { buildStack, type StackEntry } from "@/components/avatar-stack";
import { ZERO_DISPLAY_USD } from "@/lib/core/account-view";

// 三处叠标共用的那一段(#133 收尾):同键累加 → 砍尘埃 → 按量级降序。
// 各调用方自己把「一行」变成 entry(那部分三处不可能一样),排序规则只住这里。
const e = (k: string, magnitude: number, logo?: string): StackEntry => ({
  k,
  name: k,
  logo,
  magnitude,
});

describe("buildStack", () => {
  it("按量级降序", () => {
    expect(buildStack([e("a", 10), e("b", 100), e("c", 50)]).map((i) => i.k)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("**取绝对值比大小** —— 负的(空仓 / 借款腿)不因为符号垫底", () => {
    expect(buildStack([e("a", 10), e("big-short", -100)]).map((i) => i.k)).toEqual([
      "big-short",
      "a",
    ]);
  });

  it("同键累加(带符号,同一个币的多笔可以互相抵消)", () => {
    const items = buildStack([e("a", 100), e("a", -60), e("b", 50)]);
    expect(items.map((i) => i.k)).toEqual(["b", "a"]); // a 净剩 40 < 50
  });

  it("logo 取**首个有图的**,不是首见那一行", () => {
    // 同一个币可能先出现在一条还没富化到图的行上;取首见就会永远显首字母。
    expect(buildStack([e("a", 1), e("a", 1, "late.png")])[0]?.logo).toBe("late.png");
  });

  it("name 取首见", () => {
    expect(buildStack([{ ...e("A", 1), name: "aave" }, e("A", 1)])[0]?.name).toBe("aave");
  });

  it("默认按展示阈值砍掉几乎 $0 的格子", () => {
    const items = buildStack([e("real", 100), e("dust", ZERO_DISPLAY_USD / 2), e("zero", 0)]);
    expect(items.map((i) => i.k)).toEqual(["real"]);
  });

  it("逐条尘埃但**合计**过阈值 → 留(先累加再判)", () => {
    const half = ZERO_DISPLAY_USD * 0.6;
    expect(buildStack([e("a", half), e("a", half)]).map((i) => i.k)).toEqual(["a"]);
  });

  it("`dust: 0` → 只排不砍(来源那两排用它:头像个数要与「跨 n 个平台」对得上)", () => {
    expect(buildStack([e("a", 100), e("tiny", 0.0001)], 0).map((i) => i.k)).toEqual(["a", "tiny"]);
  });

  it("空 → []", () => {
    expect(buildStack([])).toEqual([]);
  });
});
