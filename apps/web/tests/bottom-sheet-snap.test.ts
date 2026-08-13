import { describe, expect, it } from "vitest";
import { nearestSnap, SHEET_MAX_HEIGHT, snapOffsets } from "../src/lib/bottom-sheet-snap";

// 底部抽屉的**策略**(片8 / ADR 0041)。能测的只有这一层:档位怎么换算成位移、投影落哪一档。
// 跟手手感、惯性参数、掉不掉帧只有真机能验 —— 别拿这几条绿的当「抽屉做好了」。
//
// 组件级手势测试**故意不写**:jsdom 没有布局也没有指针速度,拖拽在里面测不出东西,
// 只会写出一堆「模拟了 pointer 事件所以绿了」的假保证。

const MAX = 800; // 顶格高度(px),已扣掉安全区

describe("snapOffsets —— 档位换算成位移", () => {
  it("两档 + dismiss,升序:顶格 0 / 半档 / 完全移出", () => {
    expect(snapOffsets(MAX)).toEqual([0, 320, 800]);
  });

  it("最后一项恒是「完全移出」—— 下甩关闭因此和换档是同一条动画", () => {
    expect(snapOffsets(MAX).at(-1)).toBe(MAX);
  });

  it("只有一档时也对(那一档 + dismiss)", () => {
    expect(snapOffsets(MAX, [1])).toEqual([0, 800]);
    expect(snapOffsets(MAX, [0.5])).toEqual([400, 800]);
  });

  it("顶格高度还没量出来(0)→ 不产生负数或 NaN", () => {
    expect(snapOffsets(0)).toEqual([0]);
  });
});

describe("nearestSnap —— 投影落哪一档", () => {
  const offsets = snapOffsets(MAX); // [0, 320, 800]

  it("两档中间偏上 → 顶格;偏下 → 半档", () => {
    expect(nearestSnap(150, offsets)).toBe(0);
    expect(nearestSnap(170, offsets)).toBe(320);
  });

  it("半档与 dismiss 之间偏上 → 半档;偏下 → 关闭", () => {
    expect(nearestSnap(500, offsets)).toBe(320);
    expect(nearestSnap(700, offsets)).toBe(800);
  });

  it("投影远超顶格(猛甩)→ dismiss", () => {
    expect(nearestSnap(2000, offsets)).toBe(800);
  });

  it("投影为负(往上过头)→ 顶档,不越界", () => {
    expect(nearestSnap(-500, offsets)).toBe(0);
  });

  it("只有一档 + dismiss 时同样正确", () => {
    const single = snapOffsets(MAX, [1]); // [0, 800]
    expect(nearestSnap(100, single)).toBe(0);
    expect(nearestSnap(600, single)).toBe(800);
  });

  it("正好落在某一档上 → 就是它", () => {
    expect(nearestSnap(320, offsets)).toBe(320);
  });
});

// 顶格高度那个 CSS 字符串。像素值是运行时量出来的,jsdom 里没有 CSS —— 所以「有没有扣掉顶部安全区」
// 只能在这里钉住。它是「灵动岛压不到」的**全部依据**:两档都是顶格高度的分数,顶档因此天然停在
// 安全区之下,不靠 92% 那种凑出来的数字。
describe("SHEET_MAX_HEIGHT —— 顶格高度", () => {
  it("扣掉顶部安全区", () => {
    expect(SHEET_MAX_HEIGHT).toContain("env(safe-area-inset-top)");
  });

  it("用 svh 而不是 vh —— 地址栏收放时不跳", () => {
    expect(SHEET_MAX_HEIGHT).toContain("100svh");
    expect(SHEET_MAX_HEIGHT).not.toMatch(/\b100vh\b/);
  });
});
