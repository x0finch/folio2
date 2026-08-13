import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_SCROLL_ID } from "../src/lib/app-scroll";
import { useTapToTop } from "../src/lib/hooks/use-tap-to-top";

// 再点当前 tab → 滚回顶部且**不导航**(片4)。
// 「不导航」是靠 `preventDefault` 让 TanStack 的 `<Link>` 放弃这次点击(它在导航前看
// `defaultPrevented`,而使用者的 onClick 排在它前面)。所以这里盯两件事:
// 什么时候 `preventDefault`、滚的是谁。
//
// jsdom 没有布局也没有 `scrollTo`,所以容器的 `scrollTo` 用 spy 顶上 —— 要断言的是
// 「有没有滚它」「滚哪儿」,不是滚动动画本身(那在浏览器/真机)。

function mountScroller(overflowY: string) {
  const el = document.createElement("div");
  el.className = APP_SCROLL_ID;
  el.style.overflowY = overflowY;
  document.body.appendChild(el);
  const scrollTo = vi.fn();
  // jsdom 的 Element 没有 scrollTo。
  Object.defineProperty(el, "scrollTo", { value: scrollTo, writable: true });
  return { el, scrollTo };
}

function fakeClick(extra: Partial<React.MouseEvent> = {}) {
  const preventDefault = vi.fn();
  return {
    event: { button: 0, preventDefault, ...extra } as unknown as React.MouseEvent,
    preventDefault,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("useTapToTop", () => {
  it("点当前 tab → 滚回顶部,并且拦掉导航", () => {
    const { el, scrollTo } = mountScroller("auto");
    el.scrollTop = 400;
    const { result } = renderHook(() => useTapToTop());

    const { event, preventDefault } = fakeClick();
    result.current(true)(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("点别的 tab → 一点不掺和(照常切页、不滚)", () => {
    const { scrollTo } = mountScroller("auto");
    const { result } = renderHook(() => useTapToTop());

    const { event, preventDefault } = fakeClick();
    result.current(false)(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("桌面(容器不滚,滚的是整页)→ 不拦导航,让 router 自己归零", () => {
    const { scrollTo } = mountScroller("visible");
    const { result } = renderHook(() => useTapToTop());

    const { event, preventDefault } = fakeClick();
    result.current(true)(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("没有外壳的页面(登录页 / 锁屏)→ 不炸、不拦", () => {
    const { result } = renderHook(() => useTapToTop());
    const { event, preventDefault } = fakeClick();
    expect(() => result.current(true)(event)).not.toThrow();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  // 有鼠标的那段宽度(sm ≤ w < lg)仍然是手机外壳 + 内滚容器,所以这条是真会遇到的:
  // ⌘/ctrl+点 是「在新标签打开」,不是「回到顶部」—— 拦下来会把那个意图吞掉。
  it("⌘/ctrl/shift+点 或 中键 → 放行,不当成回顶", () => {
    const { el, scrollTo } = mountScroller("auto");
    el.scrollTop = 300;
    const { result } = renderHook(() => useTapToTop());

    for (const extra of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const { event, preventDefault } = fakeClick(extra);
      result.current(true)(event);
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("已经在顶上也照样拦 —— 放过去会白添一条历史条目", () => {
    const { el, scrollTo } = mountScroller("auto");
    el.scrollTop = 0;
    const { result } = renderHook(() => useTapToTop());

    const { event, preventDefault } = fakeClick();
    result.current(true)(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});
