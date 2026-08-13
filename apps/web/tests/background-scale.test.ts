import { describe, expect, it } from "vitest";
import { backgroundScaleStyle } from "../src/lib/background-scale";

// 抽屉上滑时背景往后收一层(片9 / ADR 0041)。能测的是换算,不是观感。
//
// **缩放量按固定 px 换算成比例**,不是直接给一个固定比例:同一个 `scale(0.94)` 在小屏上收进去
// 十几像素、在大屏上三十多,观感对不上;固定 px 才是「两边各让出一条同样宽的缝」。
// 这条测试就是钉住这件事 —— 换成固定比例的话,两种宽度会算出同一个 scale。

describe("backgroundScaleStyle", () => {
  it("收起(0)→ 完全不缩、无圆角", () => {
    expect(backgroundScaleStyle(0, 400)).toEqual({ scale: 1, radiusPx: 0 });
  });

  it("顶格(1)→ 两侧各收 16px:窄屏缩得多、宽屏缩得少(**换算成比例的意义就在这**)", () => {
    const narrow = backgroundScaleStyle(1, 320);
    const wide = backgroundScaleStyle(1, 1280);
    expect(narrow.scale).toBeCloseTo((320 - 32) / 320, 5);
    expect(wide.scale).toBeCloseTo((1280 - 32) / 1280, 5);
    expect(narrow.scale).toBeLessThan(wide.scale);
  });

  it("中途是连续的,不是开关式两态", () => {
    const half = backgroundScaleStyle(0.5, 400);
    const full = backgroundScaleStyle(1, 400);
    expect(half.scale).toBeLessThan(1);
    expect(half.scale).toBeGreaterThan(full.scale);
    expect(half.radiusPx).toBeCloseTo(full.radiusPx / 2, 5);
  });

  it("越界的进度被夹住(拖过头不会缩成负的或反着放大)", () => {
    expect(backgroundScaleStyle(-1, 400)).toEqual(backgroundScaleStyle(0, 400));
    expect(backgroundScaleStyle(2, 400)).toEqual(backgroundScaleStyle(1, 400));
  });

  it("视口宽度拿不到(0)→ 退化成不缩放,不返回 NaN", () => {
    const style = backgroundScaleStyle(1, 0);
    expect(style.scale).toBe(1);
    expect(Number.isNaN(style.scale)).toBe(false);
  });

  it("极窄视口不会算出负的缩放", () => {
    expect(backgroundScaleStyle(1, 20).scale).toBeGreaterThanOrEqual(0);
  });
});

// NaN 单独一条:`Math.min/max` 遇 NaN 仍是 NaN,一路传下去就是 `scale(NaN)` —— 浏览器把整条声明
// 丢掉,于是表现成「缩放没生效」而没有任何报错。抽屉开场那一下的 y 起点是 `"100%"`(百分号),
// `Number("100%")` 就是 NaN,所以这不是假想的输入。
describe("backgroundScaleStyle 的 NaN 防线", () => {
  it("进度是 NaN → 退化成不缩放", () => {
    expect(backgroundScaleStyle(Number.NaN, 400)).toEqual({ scale: 1, radiusPx: 0 });
  });
});
