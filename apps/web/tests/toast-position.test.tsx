import { Toaster, toast } from "@folio/ui";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// 手机上 toast 挪到顶部(片2)靠的是 `styles.css` 里一条选择器覆盖 —— vendored 的 <Toaster>
// 把位置写死成 bottom-right,app 侧没有入口。**选择器覆盖的失败方式是静默的**:vendored 那天
// 换个标签或去掉 aria-live,CSS 什么也不报,toast 只是又跑回底部去挡 Dock。
//
// 所以这里钉住那条 CSS 依赖的三件事:portal 到 <body> 的直接子元素、是 <ol>、带 aria-live="polite"。
// 顺带钉住「位置类确实来自 vendored 的 bottom-right」—— 那正是覆盖要盖掉的东西。
// 不断言 CSS 文件内容:那种测试要靠读源码保持一致,自己就是要被收掉的形状。

const SELECTOR = 'body > ol[aria-live="polite"]';

// toast 存在模块级 store 里,用例之间要清掉(store 的 reset 没经 @folio/ui 出口暴露,按 id 撤)。
const shown: string[] = [];
function showToast() {
  act(() => {
    shown.push(toast.message("同步完成"));
  });
}

afterEach(() => {
  act(() => {
    for (const id of shown.splice(0)) toast.dismiss(id);
  });
});

describe("toast 顶部覆盖依赖的 DOM 形状", () => {
  it("栈 portal 到 body 的直接子层,是带 aria-live=polite 的 <ol>", () => {
    render(<Toaster />);
    showToast();

    const stack = document.querySelector(SELECTOR);
    expect(stack).not.toBeNull();
    expect(stack?.tagName).toBe("OL");
    expect(stack?.parentElement).toBe(document.body);
  });

  it("位置由 vendored 写死在右下角 —— 这就是那条 CSS 要盖掉的", () => {
    render(<Toaster />);
    showToast();

    const cls = document.querySelector(SELECTOR)?.className ?? "";
    // 覆盖里写的是 `top` + `bottom: auto` + `flex-direction: column`,对应盖掉这三样。
    expect(cls).toContain("bottom-6");
    expect(cls).toContain("flex-col-reverse");
    expect(cls).toContain("fixed");
  });
});
