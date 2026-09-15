import { Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// beUI popover 的面板底色本来**只**由 goo 垫底层画(z-[-1] 的 bg-popover 过 SVG 滤镜),内容层自己
// 没底色。那条滤镜在 WebKit 上渲染成半透明 —— 面板压住背后内容(窄屏首页里就是净值/涨跌)时会透上来,
// 而 Chromium 上是实底、看不出,e2e(只跑 Chromium)也就抓不到。修法是让**内容层自带 bg-popover**
// (popover.tsx 的 measureRef),一次覆盖全部调用点。
//
// 这条钉的就是那层实底:beUI 件是**冻结的 fork**(见 popover.tsx 顶注),哪天有人从 registry 重新
// 拉一遍把这个文件盖掉、把 bg-popover 丢了,这条会红 —— 那正是这个 bug 反复回来的原因(改一处、
// 换个浏览器/布局又冒出来),用一条浏览器无关的断言把它焊死。
describe("beUI popover 面板自带不透明底色", () => {
  it("PopoverContent 渲染出的面板带 bg-popover 实底", () => {
    const { container } = render(
      <Popover open>
        <PopoverTrigger>
          <button type="button">trigger</button>
        </PopoverTrigger>
        <PopoverContent>panel body</PopoverContent>
      </Popover>,
    );
    const panel = container.querySelector('[role="dialog"]');
    expect(panel, "popover 面板(role=dialog)应当渲染出来").not.toBeNull();
    expect(
      panel?.className,
      "面板必须自带不透明底色,不能只靠 goo 垫底层(WebKit 上半透明)",
    ).toContain("bg-popover");
  });
});
