import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { APP_SCROLL_ID, APP_SCROLL_SELECTOR } from "../src/lib/app-scroll";
import { useIsScrollLocked, useScrollLock } from "../src/lib/hooks/use-scroll-lock";

// 锁的是**那个容器**,不是 body(ADR 0042)。手机上滚动已经挪进容器,锁 body 的 overflow
// 什么也不锁 —— 所以这里盯三件事:锁/解锁、多个调用者叠加、卸载时恢复。
// 手势与布局不在 jsdom 里验(没有布局、没有指针),那部分靠真机。

function mountContainer(overflowY: string): HTMLElement {
  document.body.innerHTML = `<div class="${APP_SCROLL_ID}"></div>`;
  const el = document.querySelector<HTMLElement>(APP_SCROLL_SELECTOR);
  if (!el) throw new Error("fixture did not mount");
  // 容器是不是滚动容器由 CSS 说(手机 auto / 桌面 visible);jsdom 里用内联样式立这个事实。
  el.style.overflowY = overflowY;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useScrollLock", () => {
  it("锁上时把容器的纵向滚动关掉,解锁后还原成原来的值", () => {
    const el = mountContainer("auto");
    const { rerender } = renderHook(({ locked }: { locked: boolean }) => useScrollLock(locked), {
      initialProps: { locked: false },
    });
    expect(el.style.overflowY).toBe("auto");

    rerender({ locked: true });
    expect(el.style.overflowY).toBe("hidden");

    rerender({ locked: false });
    expect(el.style.overflowY).toBe("auto");
  });

  // **先松开的必须是第一个** —— 这是这条测试唯一抓得住 bug 的顺序。第二个调用者锁的时候容器
  // 已经是 hidden 了,少一句「已锁就直接认」的判定就会把它判成「不是滚动容器」而静默不锁;
  // 那时先放第二个仍然是绿的(计数恰好凑对),先放第一个才会露出「背景又能滚了」。
  it("两个调用者叠加:先松开的那个不会提前放开容器,两个都松开才还原", () => {
    const el = mountContainer("auto");
    const first = renderHook(() => useScrollLock(true));
    const second = renderHook(() => useScrollLock(true));
    expect(el.style.overflowY).toBe("hidden");

    first.unmount();
    // 仍有一个抽屉开着 → 背景照旧不许滚。
    expect(el.style.overflowY).toBe("hidden");

    second.unmount();
    expect(el.style.overflowY).toBe("auto");
  });

  it("卸载时恢复,即使 locked 一直是 true", () => {
    const el = mountContainer("auto");
    const { unmount } = renderHook(() => useScrollLock(true));
    expect(el.style.overflowY).toBe("hidden");
    unmount();
    expect(el.style.overflowY).toBe("auto");
  });

  it("容器不是滚动容器(桌面滚整页)→ 什么都不做", () => {
    // 桌面那条路由 vendored Drawer 锁 body 负责(ADR 0042);这个 hook 在那儿必须是个空操作,
    // 否则会凭空给这个元素加一个裁剪上下文。
    const el = mountContainer("visible");
    const { unmount } = renderHook(() => useScrollLock(true));
    expect(el.style.overflowY).toBe("visible");
    unmount();
    expect(el.style.overflowY).toBe("visible");
  });

  it("页面上没有滚动容器(登录页 / 锁屏)→ 不炸", () => {
    const { unmount } = renderHook(() => useScrollLock(true));
    expect(() => unmount()).not.toThrow();
  });
});

// 「现在有没有东西锁着」这个布尔要能被别人读到:下拉刷新靠它在抽屉打开时让位(片10)。
// **判据取锁而不是抽屉的动画进度** —— 锁是打开那一刻同步置上的,不用等任何一帧动画;
// 用进度的话开场那几帧进度还是 0,那几帧里下拉是活的。
describe("useIsScrollLocked", () => {
  it("没人锁 → false;锁上 → true;全松开 → 回到 false", () => {
    mountContainer("auto");
    const probe = renderHook(() => useIsScrollLocked());
    expect(probe.result.current).toBe(false);

    const sheet = renderHook(() => useScrollLock(true));
    expect(probe.result.current).toBe(true);

    sheet.unmount();
    expect(probe.result.current).toBe(false);
    probe.unmount();
  });

  it("两个锁定者:先松开一个仍然是 true", () => {
    mountContainer("auto");
    const probe = renderHook(() => useIsScrollLocked());
    const first = renderHook(() => useScrollLock(true));
    const second = renderHook(() => useScrollLock(true));
    expect(probe.result.current).toBe(true);

    first.unmount();
    expect(probe.result.current).toBe(true);

    second.unmount();
    expect(probe.result.current).toBe(false);
    probe.unmount();
  });
});
