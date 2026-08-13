import { useReducedMotion } from "motion/react";
import type { MouseEvent } from "react";
import { useCallback } from "react";
import { appScroller, isScrolling } from "../app-scroll";

/**
 * 已经在某个 tab 上时再点它一次 → 内容滚回顶部,**并且不发生导航**(片4)。
 *
 * 返回一个「给某个 tab 用的 onClick」:`active` 为假就什么都不做,让 `<Link>` 照常切页。
 * 抽成 hook 而不是包一层组件 —— 底部 Dock 与桌面侧栏是两套不同的外壳标记,共用的是这段行为。
 *
 * `preventDefault` 之所以拦得住导航:TanStack 的 `<Link>` 把使用者的 `onClick` 排在它自己的
 * 处理之前(`composeHandlers([onClick, handleClick])`),而它在导航前会看 `e.defaultPrevented`。
 *
 * 桌面**故意不接**:那边滚的是整页,router 自己就会把 window 归零(ADR 0042 的两种模型)。
 * 所以判据是「容器此刻在不在滚」,不是断点。
 */
export function useTapToTop(): (active: boolean) => (event: MouseEvent) => void {
  const reduce = useReducedMotion() ?? false;

  return useCallback(
    (active: boolean) => (event: MouseEvent) => {
      if (!active) return;
      const el = appScroller();
      if (!el || !isScrolling(el)) return;
      // 已经在顶上时也照样拦:AC 要的是「点当前 tab 不产生导航」,放过去会多一条历史条目,
      // 而且那次导航只会做一遍无谓的归零。滚到 0 本身是幂等的。
      event.preventDefault();
      el.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    },
    [reduce],
  );
}
