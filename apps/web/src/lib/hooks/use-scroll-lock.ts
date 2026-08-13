import { useEffect, useSyncExternalStore } from "react";
import { appScroller, isScrolling } from "../app-scroll";

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

// 「现在有没有东西锁着」也要能被别人读到:下拉刷新得在抽屉打开时让位(片10)。
// 用订阅而不是共享一个 state —— 锁是命令式的、跨组件的,而读它的人只关心那个布尔。
const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}

function lockTarget(): HTMLElement | null {
  const el = appScroller();
  if (!el) return null; // 登录页 / 锁屏没有外壳
  // 已经锁着了 → computed 现在是 hidden,再问一遍会把自己判成「不是滚动容器」,
  // 第二个调用者就锁不上、第一个一松手背景又能滚了。
  if (locks.has(el)) return el;
  return isScrolling(el) ? el : null;
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
  notify();
}

function release(el: HTMLElement): void {
  const held = locks.get(el);
  if (!held) return;
  held.holders -= 1;
  if (held.holders > 0) return;
  el.style.overflowY = held.restore;
  locks.delete(el);
  notify();
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

/**
 * 现在有没有抽屉/弹层锁着背景。
 *
 * 下拉刷新用它让位(片10):抽屉自己也有下拉手势,两个一起吃同一下会打架。
 * **判据取「锁」而不是抽屉的动画进度**:锁是打开那一刻同步置上的,不依赖任何一帧动画;
 * 用进度的话,开场那几帧进度还是 0,那几帧里下拉仍然是活的。
 */
export function useIsScrollLocked(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => locks.size > 0,
    () => false,
  );
}
