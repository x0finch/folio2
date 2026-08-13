import { type MotionValue, useReducedMotion } from "motion/react";
import { type RefObject, useEffect } from "react";
import { backgroundScaleStyle } from "../background-scale";

/**
 * 抽屉上滑时把外壳整屏往后收一层(片9 / ADR 0041)。
 *
 * **transform 开时加、关时彻底删掉**,不是留一个恒等缩放:任何非 `none` 的 transform 都让该元素
 * 成为 `position: fixed` 后代的包含块 —— 壳上一旦留着,壳内的底部 Dock 与非 portal 的全屏弹层
 * (同步面板那个 `fixed inset-0`)就会退化成相对壳定位、随页面滚走。这个坑仓库里踩过,
 * 注释在 `components/portal.tsx`。
 *
 * 每帧只写这一层的 `transform` / `border-radius`(合成属性),不写 CSS 变量、不引起重算。
 * 减少动态效果时**整层跳过** —— 不是缩得慢一点。
 *
 * 进度**当参数传进来**、不从 context 读:外壳自己在 Provider 的外面,从 context 读只会拿到
 * 那个恒为 0 的缺省值(抽屉在 Provider 里面,所以它读 context 是对的)。
 */
export function useBackgroundScale(
  ref: RefObject<HTMLElement | null>,
  progress: MotionValue<number>,
): void {
  const reduce = useReducedMotion() ?? false;

  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;

    const clear = () => {
      el.style.transform = "";
      el.style.borderRadius = "";
      el.style.transformOrigin = "";
    };

    const apply = (value: number) => {
      if (value <= 0) {
        clear();
        return;
      }
      const style = backgroundScaleStyle(value, window.innerWidth);
      el.style.transformOrigin = "top center";
      el.style.transform = `scale(${style.scale})`;
      el.style.borderRadius = `${style.radiusPx}px`;
    };

    apply(progress.get());
    const stop = progress.on("change", apply);
    return () => {
      stop();
      clear();
    };
  }, [ref, progress, reduce]);
}
