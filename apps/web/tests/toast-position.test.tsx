import { Toaster, toast } from "@folio/ui";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// toast 的落位(片2 / #470):手机顶部、桌面右下角。
//
// 位置是**传给组件的**(`position` + `classNames.root`),不是从外面用选择器盖 DOM ——
// 第一版是后者,耦合的是 vendored stack 的 DOM 形状(portal 到 body 的那个 `<ol aria-live>`),
// 那种耦合的失败是静默的:哪天那个件换个标签,CSS 不报错,toast 只是又跑回底部挡 Dock。
//
// 这里测的是 `<Toaster>` 这个出口把落位真的透了下去,以及安全区那一下能盖掉它自带的 `top-4`。
// 「手机走顶部、桌面走右下角」那半在 `__root` 里按断点选,属排版决定,不在这一层。

const STACK = 'ol[aria-live="polite"]';
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

describe("<Toaster> 的落位入口", () => {
  it("默认右下角(桌面)", () => {
    render(<Toaster />);
    showToast();
    const cls = document.querySelector(STACK)?.className ?? "";
    expect(cls).toContain("bottom-6");
    expect(cls).toContain("right-4");
    // 底部堆叠:最新的贴角落,所以是 reverse。
    expect(cls).toContain("flex-col-reverse");
  });

  it("传 top-right → 顶部,且堆叠方向翻过来(最新的在最上面)", () => {
    render(<Toaster position="top-right" />);
    showToast();
    const cls = document.querySelector(STACK)?.className ?? "";
    expect(cls).toContain("top-4");
    expect(cls).not.toContain("bottom-6");
    expect(cls).toContain("flex-col");
    expect(cls).not.toContain("flex-col-reverse");
  });

  it("classNames.root 能盖掉它自带的 top-4 —— 手机上要叠安全区,不能压刘海", () => {
    render(
      <Toaster
        position="top-right"
        classNames={{ root: "top-[calc(env(safe-area-inset-top)+0.75rem)]" }}
      />,
    );
    showToast();
    const cls = document.querySelector(STACK)?.className ?? "";
    expect(cls).toContain("top-[calc(env(safe-area-inset-top)+0.75rem)]");
    // twMerge 冲突消解:同一属性只留后来的那个。
    expect(cls).not.toMatch(/(^|\s)top-4(\s|$)/);
  });
});
