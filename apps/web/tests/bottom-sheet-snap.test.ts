import { describe, expect, it } from "vitest";
import { chooseSnap, SHEET_MAX_HEIGHT, snapOffsets } from "../src/lib/bottom-sheet-snap";

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

// 松手落哪一档。**上一版是「惯性投影落最近档」,被真机推翻了** —— 那样换档距离恒等于半个间距
// (实测 338px 的间距要拖过 169px 才认),拖 120px 松手会弹回去,像「往上滑不认」。
// 现在是原生那套:朝拖动方向看相邻那一档,拖过间距的 20% 或甩得够快就换过去。
describe("chooseSnap —— 松手落哪一档", () => {
  const offsets = snapOffsets(MAX); // [0, 320, 800];半档 320,dismiss 800
  const slow = 0;

  it("从半档往上拖过 20%(64px)→ 换到顶格", () => {
    expect(chooseSnap({ from: 320, offsets, offset: -70, velocity: slow })).toBe(0);
  });

  it("从半档往上只拖一点点(50px)→ 回半档,不误换", () => {
    expect(chooseSnap({ from: 320, offsets, offset: -50, velocity: slow })).toBe(320);
  });

  it("**拖 120px 必须换档** —— 这条就是真机上那个「往上滑不认」", () => {
    expect(chooseSnap({ from: 320, offsets, offset: -120, velocity: slow })).toBe(0);
  });

  it("往上轻甩(速度够)→ 换档,不看拖了多远", () => {
    expect(chooseSnap({ from: 320, offsets, offset: -12, velocity: -900 })).toBe(0);
  });

  it("从半档往下拖过 20%(96px)→ dismiss", () => {
    expect(chooseSnap({ from: 320, offsets, offset: 120, velocity: slow })).toBe(800);
  });

  it("从半档往下拖一点点(60px)→ 回半档,不误关", () => {
    expect(chooseSnap({ from: 320, offsets, offset: 60, velocity: slow })).toBe(320);
  });

  it("往下猛甩 → dismiss", () => {
    expect(chooseSnap({ from: 320, offsets, offset: 20, velocity: 1200 })).toBe(800);
  });

  it("已经在顶格还往上拖 → 原地不动(没有更上一档)", () => {
    expect(chooseSnap({ from: 0, offsets, offset: -200, velocity: -1500 })).toBe(0);
  });

  it("从顶格往下拖过 20% → 落半档,不会一步跳到 dismiss", () => {
    expect(chooseSnap({ from: 0, offsets, offset: 100, velocity: slow })).toBe(320);
  });

  it("一动没动就松手 → 原档", () => {
    expect(chooseSnap({ from: 320, offsets, offset: 0, velocity: 0 })).toBe(320);
  });

  it("方向以速度为准:往下拖过头又往上甩 → 按甩的方向走", () => {
    expect(chooseSnap({ from: 320, offsets, offset: 40, velocity: -800 })).toBe(0);
  });

  it("只有一档 + dismiss 时也对", () => {
    const single = snapOffsets(MAX, [1]); // [0, 800]
    expect(chooseSnap({ from: 0, offsets: single, offset: 200, velocity: slow })).toBe(800);
    expect(chooseSnap({ from: 0, offsets: single, offset: 60, velocity: slow })).toBe(0);
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
