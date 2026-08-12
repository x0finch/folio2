import { useEffect } from "react";
import { appScroller } from "../app-scroll";

// 锁住应用滚动容器的滚动(抽屉 / 弹层打开时背景不许跟着滚)。
//
// **为什么不是锁 body**:手机上滚动已经挪进容器了(ADR 0042),body 根本不滚 ——
// vendored 的 `BottomSheet` / `Drawer` 里那两行 `document.body.style.overflow = "hidden"`
// 在手机上于是什么也不锁。它们是 registry 装出来的、一个字都不能改,所以这一层在 app 侧补:
// 谁开抽屉谁调这个 hook,锁的是真正在滚的那个元素。两边同时锁没有害处(一个是空操作)。
//
// 桌面**故意**还滚整页(ADR 0042:侧滑 `Drawer` 靠锁 body 挡背景),那时这个容器的
// `overflow-y` 是 `visible` —— 见下面 `scrollerOf` 的判定,这个 hook 在桌面是空操作。

// 每个被锁元素记一份:还有几个调用者按着它 + 它自己原来的内联 overflow-y。
// 多个抽屉/弹层可能同时开(账户抽屉里还能再开确认弹窗),后关的那个不该提前把背景放开。
const locks = new Map<HTMLElement, { holders: number; restore: string }>();

function lockTarget(): HTMLElement | null {
  const el = appScroller();
  if (!el) return null; // 登录页 / 锁屏没有外壳
  // 已经锁着了 → computed 现在是 hidden,再问一遍会把自己判成「不是滚动容器」,
  // 第二个调用者就锁不上、第一个一松手背景又能滚了。
  if (locks.has(el)) return el;
  const { overflowY } = getComputedStyle(el);
  return overflowY === "auto" || overflowY === "scroll" ? el : null;
}

// `overflow-y: hidden` 保留 scrollTop(只是用户滚不动,程序仍可滚),所以关掉抽屉后
// 页面还停在原处 —— 不需要像旧的 `position: fixed` 那样自己记 `window.scrollY` 再滚回去。
function acquire(el: HTMLElement): void {
  const held = locks.get(el);
  if (held) {
    held.holders += 1;
    return;
  }
  locks.set(el, { holders: 1, restore: el.style.overflowY });
  el.style.overflowY = "hidden";
}

function release(el: HTMLElement): void {
  const held = locks.get(el);
  if (!held) return;
  held.holders -= 1;
  if (held.holders > 0) return;
  el.style.overflowY = held.restore;
  locks.delete(el);
}

export function useScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    const el = lockTarget();
    if (!el) return;
    acquire(el);
    return () => release(el);
  }, [locked]);
}
